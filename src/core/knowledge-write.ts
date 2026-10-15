/**
 * The Knowledge library's write path (knowledge-library.md K17; brief 4.4): ONE deterministic composite the model states
 * intent to ("composite over dance"), with the sequencing in code.
 *
 *   receipt → gates → candidate and diff → check inputs → guide check (a coach) → loop with the chat model
 *   → direct apply OR approval card → apply under the per-root lock → History
 *
 * What a model can and cannot do here:
 *  - `knowledge_write` applies directly only for an exact edit the owner asked for in a live owner turn in which nothing
 *    untrusted was read; everything else becomes an approval card (never silent). `knowledge_propose` and
 *    `knowledge_create_set` always stage a card. Continuations and unattended runs may only propose.
 *  - Only a CLEAR breach of the guide holds a write (`must_fix`, verified by code in knowledge-check.ts); the model gets a
 *    fixable list and revises, up to 3 attempts per change; then the change becomes a card for the owner, never a dead end.
 *  - A check that cannot run holds the write (`held`); it is never applied unchecked.
 *  - Nothing is applied without the independent guide check except through the owner's click on a card, which applies only
 *    the stored candidate; the deterministic gates (path, type, size, generated file, read-only set, receipt, stale base,
 *    secret formats) stay absolute for every route.
 * The guide is Operating Knowledge: it governs how files are written and can never change BotBoy's approvals, sandbox or
 * send rules. Library text is untrusted data.
 */
import type Database from 'better-sqlite3';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createGuideCheck, secretItems, type CheckInput, type CheckItem, type GuideCheck } from './knowledge-check.js';
import type { GuideDrafter } from './knowledge-draft.js';
import { diffLines, renderUnifiedDiff } from './knowledge-diff.js';
import { pruneEmptyFolders, readIfExists, realParentInside, sha256Hex, writeFileAtomic, isInside } from './knowledge-fs.js';
import { addCategoryRow, removeFileRow, removeTocSection, renameFileRow, renameTocSection, setTocSection, upsertFileRow } from './knowledge-guide-edit.js';
import { estimateTokens, parseGuide, rulesDigest, type GuideCategory, type ParsedGuide, type SetKind } from './knowledge-guide.js';
import type { KnowledgeHistory, CheckNote } from './knowledge-history.js';
import type { InspectResult, KnowledgeLibrary, LibrarySet } from './knowledge-library.js';
import {
  CHANGE_ID_RE, type ChangePatch, type ChangePlan, type KnowledgeChange, type KnowledgeChangeStore, type PlannedFile, type ProposalTrigger, type WriteMode,
} from './knowledge-changes.js';
import {
  RULES_MAX_TOKENS, ROOT_SET_ID, buildRulesPayload, buildWriteInstructionsBlock, checkReceipt, ownerAskedForEdit, rowFor, shortHash, summaryFor, targetKindOf, type GuideDelivery, type TargetKind,
} from './knowledge-rules.js';
import { turnIsTainted, untrustedSourcesOf } from './knowledge-taint.js';
import { GUIDE_FILE_NAME, ROOT_GUIDE_SEED, closestTemplate } from './knowledge-templates.js';
import {
  MAX_RESULT_BYTES, MAX_SET_ID_CHARS, applyEdits, failure, generatedFileReason, hashText, importSourceStillMatches, readImportSource, readLibraryText,
  relativeToRoot, resolveInsideSet, restoreView, tiedFileNames, validateFileName, validateWritableType, viewOf, type Failure,
} from './knowledge-write-support.js';
import { writeFileMaxChars } from './limits.js';
import { detectSecrets } from './sensitive-files.js';
import type { ToolExecutionContext } from './tool-executor.js';

export const MAX_ATTEMPTS = 3;
export const MAX_NEW_CHANGES_PER_REQUEST = 5;
export const MAX_PLAN_BYTES = 2 * 1024 * 1024;
const MAX_SET_LEVEL_FILES = 200;
const MAX_SET_LEVEL_BYTES = 8 * 1024 * 1024;
const WRITE_MODES: readonly WriteMode[] = ['create', 'append', 'edit', 'replace', 'import', 'move', 'archive'];
/** Folders of the built-in analytics set that hold generated files, never sets of their own. */
const RESERVED_SET_FOLDERS: readonly string[] = ['analytics/presets', 'analytics/lessons'];
/** The modes whose guide refresh depends on the model's summaries (a new row, a TOC summary). */
const REFRESHABLE_MODES: readonly string[] = ['create', 'import', 'append', 'edit', 'replace'];
const TRIGGERS: readonly ProposalTrigger[] = ['verified_fact', 'owner_correction', 'new_column', 'workaround', 'other'];

export type WriterTool = 'knowledge_write' | 'knowledge_propose' | 'knowledge_create_set';

export interface WriterReply {
  ok: boolean;
  status: 'applied' | 'staged' | 'needs_changes' | 'failed';
  code?: string;
  message: string;
  nextAction: string;
  effect: 'none' | 'applied' | 'staged' | 'unknown';
  changeId?: string;
  [extra: string]: unknown;
}

export interface KnowledgeWriterDeps {
  db: Database.Database;
  library: KnowledgeLibrary;
  history: KnowledgeHistory;
  check: GuideCheck;
  drafter: GuideDrafter;
  changes: KnowledgeChangeStore;
  now?: () => number;
}

export interface ApplyOptions { anyway?: boolean; confirmFlagged?: boolean }

export type ApplyResult =
  | { ok: true; change: KnowledgeChange; historyId: string; summary: string }
  | { ok: false; code: string; message: string; nextAction: string; status?: number; change?: KnowledgeChange };

export interface KnowledgeWriter {
  write(args: Record<string, unknown>, context: ToolExecutionContext | undefined, tool: 'knowledge_write' | 'knowledge_propose'): Promise<WriterReply>;
  createSet(args: Record<string, unknown>, context: ToolExecutionContext | undefined): Promise<WriterReply>;
  /** The owner's click on a staged card. */
  apply(changeId: string, options?: ApplyOptions): Promise<ApplyResult>;
  dismiss(changeId: string): KnowledgeChange | null;
  /** Run the guide check again on a held or staged change (no model tool; owner click only). */
  recheck(changeId: string, options?: { signal?: AbortSignal }): Promise<ApplyResult>;
  undo(): Promise<Awaited<ReturnType<KnowledgeHistory['undo']>>>;
  /** The rules payload a `guide_not_read` answer would deliver, for the chat seam's open-change block. */
  rulesPayloadFor(setId: string, file: string): Promise<{ fence: string; trailer: string; delivery: GuideDelivery; rulesSha256: string } | Failure>;
  /**
   * The instructions block the chat seam hands the drafting model BEFORE it drafts, for a matched, writable, guided set (the
   * rules as instructions, brief 4.4), with the delivery it covers; null when the set cannot be written to.
   */
  writeBlockFor(setId: string): Promise<{ text: string; delivery: GuideDelivery | null } | null>;
}

interface Target {
  isRoot: boolean;
  setId: string;
  kind: SetKind;
  name: string;
  dir: string;
  guidePath: string | null;
  guideText: string;
  guide: ParsedGuide | null;
  digest: string | null;
  writable: boolean;
  set: LibrarySet | null;
  setNames: string[];
  keywords: string[];
}

const ok = (reply: Omit<WriterReply, 'ok'>): WriterReply => ({ ok: true, ...reply } as WriterReply);
const fail = (code: string, message: string, nextAction: string, extra: Record<string, unknown> = {}): WriterReply =>
  ({ ok: false, status: 'failed', code, message, nextAction, effect: 'none', ...extra });
const fromFailure = (value: Failure): WriterReply => fail(value.code, value.message, value.nextAction, value.details ?? {});

const isGuideName = (name: string) => path.basename(name).toLowerCase() === GUIDE_FILE_NAME.toLowerCase();
const clip = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`);
const stripExtension = (name: string) => name.replace(/\.[^.]+$/, '');

function requestState(context: ToolExecutionContext | undefined): NonNullable<ToolExecutionContext['knowledgeRequest']> {
  if (!context) return { newChanges: 0, replies: new Map(), seenChangeIds: new Set(), bornIds: new Set() };
  context.knowledgeRequest ??= { newChanges: 0, replies: new Map(), seenChangeIds: new Set(), bornIds: new Set() };
  return context.knowledgeRequest;
}

/** A change this request touched; `isNew` marks one it created (only those may be revised and applied directly). */
function touch(state: NonNullable<ToolExecutionContext['knowledgeRequest']>, row: { id: string }, isNew: boolean): void {
  state.seenChangeIds.add(row.id);
  if (isNew) state.bornIds.add(row.id);
}

/**
 * A change this request already finished (a card now waiting for the owner) is closed for the model: only the owner's "Ask BotBoy
 * to fix" or Re-draft in a LATER turn reopens it, with a new round. Without this, calling again with the same changeId would be a
 * "reopen" with a fresh attempt count and a fresh model check each time (P2 review R24).
 */
function waitingForOwner(change: { id: string; status: string }, state: NonNullable<ToolExecutionContext['knowledgeRequest']>): boolean {
  return change.status !== 'revising' && state.seenChangeIds.has(change.id);
}

function waitingReply(change: { id: string }): WriterReply {
  return fail('change_waiting', 'This turn already finished that change: it is a card waiting for the owner.', 'Tell the owner a card is waiting in this chat and in Settings → Knowledge, and do not call with this changeId again. A new round starts only when the owner presses Ask BotBoy to fix or Re-draft on the card.', { changeId: change.id });
}

/** Record what a rules delivery covered; a delivery for a changed digest replaces the old one. */
export function recordDelivery(context: ToolExecutionContext | undefined, setId: string, delivery: GuideDelivery): void {
  if (!context) return;
  const map = (context.guidesDelivered ??= {});
  const old = map[setId];
  if (old && old.rulesSha256 === delivery.rulesSha256) {
    map[setId] = { rulesSha256: delivery.rulesSha256, full: old.full || delivery.full, whole: old.whole || delivery.whole, files: [...new Set([...old.files, ...delivery.files])] };
  } else {
    map[setId] = { rulesSha256: delivery.rulesSha256, full: delivery.full, whole: delivery.whole, files: [...delivery.files] };
  }
}

function sourceLabel(sources: readonly string[]): string {
  return sources.length ? sources.join(', ') : '';
}

export function createKnowledgeWriter(deps: KnowledgeWriterDeps): KnowledgeWriter {
  const { library, history, changes } = deps;
  const check = deps.check ?? createGuideCheck({ client: () => null });

  // ── targets ──────────────────────────────────────────────────────────────

  async function buildTarget(inspected: InspectResult): Promise<Target | Failure> {
    const { set } = inspected;
    if (!set) {
      if (!inspected.rootGuidePath) return failure('guide_required', 'The Knowledge folder has no root GUIDE.md to edit.', 'Ask the owner to create it in Finder, or open Settings → Knowledge.');
      const text = await readIfExists(inspected.rootGuidePath).catch(() => null);
      if (!text) return failure('guide_required', 'The root GUIDE.md could not be read.', 'Open Settings → Knowledge.');
      const guideText = text.toString('utf8');
      const guide = parseGuide(guideText);
      return {
        isRoot: true, setId: ROOT_SET_ID, kind: 'generic', name: 'Knowledge root', dir: inspected.root, guidePath: inspected.rootGuidePath, guideText, guide,
        digest: rulesDigest(guide), writable: true, set: null, setNames: ['root', 'library', 'knowledge'], keywords: [],
      };
    }
    if (!set.writable) return failure('read_only_set', `${set.name} is read-only: its guide says writable: no.`, 'Only the owner can change that: they set "writable: yes" in the guide, in Finder or an editor.');
    let guideText = '';
    let guide: ParsedGuide | null = null;
    if (set.hasGuide && set.guidePath) {
      const bytes = await readIfExists(set.guidePath).catch(() => null);
      if (bytes) { guideText = bytes.toString('utf8'); guide = parseGuide(guideText); }
    }
    if (!guide || guide.issues.some((issue) => issue.code === 'guide_too_large' || issue.code === 'guide_has_secret' || issue.code === 'parse_error')) {
      return failure('guide_required', `${set.name} has no usable guide yet, so BotBoy does not write to it.`, 'Create a guide with knowledge_create_set (adopt: true) and the owner approves it, or write GUIDE.md in Finder.');
    }
    return {
      isRoot: false, setId: set.id, kind: set.kind, name: set.name, dir: set.dir, guidePath: set.guidePath, guideText, guide, digest: rulesDigest(guide),
      writable: true, set, setNames: [set.name, set.id, set.id.split('/').pop() as string], keywords: [...set.headerKeywords, ...set.keywords],
    };
  }

  async function targetFor(setId: string): Promise<{ target: Target; inspected: InspectResult } | Failure> {
    const inspected = await library.inspect(setId);
    if (!('ok' in inspected) || inspected.ok !== true) {
      const bad = inspected as { code: string; message: string; nextAction: string; details?: Record<string, unknown> };
      return failure(bad.code, bad.message, bad.nextAction, bad.details);
    }
    const target = await buildTarget(inspected);
    if ('code' in target && target.ok === false) return target;
    return { target: target as Target, inspected };
  }

  // ── receipt ──────────────────────────────────────────────────────────────

  /** The set's file names (set-relative), which a guide row, entry or TOC summary is matched against; none for the root guide. */
  function namesOf(target: Target): string[] {
    return target.set ? target.set.files.map((entry) => entry.name) : [];
  }

  function targetKindFor(target: Target, file: string): TargetKind {
    if (isGuideName(file)) return 'guide';
    return target.guide ? targetKindOf(target.guide, file, namesOf(target)) : 'new';
  }

  /** `guide_not_read` for the first (set, file) the call touches that the turn's rules delivery does not cover. */
  function receiptFailure(context: ToolExecutionContext | undefined, claimed: unknown, touches: Array<{ target: Target; file: string; kindOverride?: TargetKind; ownDelivery?: boolean }>): WriterReply | null {
    for (const touch of touches) {
      const guide = touch.target.guide;
      if (!guide || !touch.target.digest) continue;
      const kind = touch.kindOverride ?? targetKindFor(touch.target, touch.file);
      const delivered = context?.guidesDelivered?.[touch.target.setId];
      // A call carries ONE rulesSha256, so the other set of a cross-set move is judged on its own delivery this turn: it was
      // handed over, it is current, and it covers the new name.
      const verdict = checkReceipt({
        delivered, claimed: touch.ownDelivery && delivered ? delivered.rulesSha256 : claimed, currentDigest: touch.target.digest, target: { file: touch.file, kind },
      });
      if (verdict.ok) continue;
      const payload = buildRulesPayload({ setId: touch.target.setId, kind: touch.target.kind, guide, guideText: touch.target.guideText, target: { file: touch.file, kind }, names: namesOf(touch.target) });
      if (payload.tooLong) {
        return fail('rules_too_long', `The rules of ${touch.target.name} are too long to hand to the drafting model (about ${payload.estimatedTokens.toLocaleString('en-US')} tokens, limit ${RULES_MAX_TOKENS.toLocaleString('en-US')}).`, 'Tell the owner to shorten the Guardrails or the Change Methodology in the guide (in Finder or an editor); BotBoy never writes without delivering the rules.');
      }
      recordDelivery(context, touch.target.setId, payload.delivery);
      return fail('guide_not_read', verdict.reason === 'missing' || verdict.reason === 'not_delivered'
        ? `Before changing ${touch.file} you need ${touch.target.name}'s rules. They are in this result.`
        : `The rulesSha256 you sent does not cover ${touch.file} (${verdict.reason}). The rules for exactly this change are in this result.`,
      'Draft the change following these rules, then call again with the same arguments and rulesSha256 from this result.', {
        rulesSha256: payload.delivery.rulesSha256, rules: payload.fence, rulesNote: payload.trailer, reason: verdict.reason,
      });
    }
    return null;
  }

  // ── authority ────────────────────────────────────────────────────────────

  function authorityFailure(tool: WriterTool, args: Record<string, unknown>, context: ToolExecutionContext | undefined): WriterReply | null {
    if (tool === 'knowledge_propose') return null;
    const live = context?.callerKind === 'interactive' && Boolean(context?.currentUserMessage?.trim());
    if (!live) {
      return fail('owner_turn_required', 'Changing the Knowledge library directly needs the owner\'s live chat turn; this run may only propose.', 'Use knowledge_propose (it stages an approval card for the owner), or finish and tell the owner.');
    }
    if (!context?.ownerRequestId?.trim() || args.ownerRequested !== true) {
      return fail('owner_request_required', 'ownerRequested must be true: change the library directly only when the owner asked for this change in the current message.', tool === 'knowledge_create_set'
        ? 'If the owner asked for this new set, call again with ownerRequested=true; otherwise ask them.'
        : 'If the owner asked for this change, call again with ownerRequested=true; if you found it yourself, use knowledge_propose.');
    }
    return null;
  }

  // ── plan: the candidate ──────────────────────────────────────────────────

  interface Parsed {
    set: string; file: string | null; mode: WriteMode; rulesSha256: unknown; why: string; trigger: ProposalTrigger | null;
    content?: string; edits?: Array<{ find: string; replace: string }>; from?: string; toFile?: string; toSet?: string; baseSha256?: string;
    changeId?: string; stageAsIs: boolean;
  }

  function parseWriteArgs(args: Record<string, unknown>, tool: WriterTool): Parsed | WriterReply {
    const set = typeof args.set === 'string' ? args.set.trim() : '';
    if (!set || set.length > MAX_SET_ID_CHARS) return fail('invalid_arguments', 'set is required (a set id of at most 120 characters).', 'Call knowledge_list to get the set ids, then call again.');
    const mode = args.mode as WriteMode;
    if (!WRITE_MODES.includes(mode)) return fail('invalid_arguments', `mode must be one of ${WRITE_MODES.join(', ')}.`, 'Fix mode, then call again.');
    const file = typeof args.file === 'string' && args.file.trim() ? args.file.trim() : null;
    const setLevel = file === null && (mode === 'move' || mode === 'archive');
    if (!file && !setLevel) return fail('invalid_arguments', 'file is required (a name from knowledge_list; only a whole-set move or archive leaves it out).', 'Add file, then call again.');
    const why = typeof args.why === 'string' ? args.why.trim().slice(0, 600) : '';
    if (tool === 'knowledge_propose' && !why) return fail('invalid_arguments', 'why is required: one sentence on what was verified and where.', 'Add why, then call again.');
    const triggerRaw = args.trigger === undefined ? 'other' : args.trigger;
    if (tool === 'knowledge_propose' && !TRIGGERS.includes(triggerRaw as ProposalTrigger)) return fail('invalid_arguments', `trigger must be one of ${TRIGGERS.join(', ')}.`, 'Fix trigger, then call again.');
    const edits = args.edits === undefined ? undefined : Array.isArray(args.edits) ? (args.edits as Array<{ find: string; replace: string }>) : null;
    if (edits === null) return fail('invalid_arguments', 'edits must be a list of {find, replace}.', 'Fix edits, then call again.');
    for (const key of ['content', 'from', 'toFile', 'toSet', 'baseSha256', 'changeId'] as const) {
      if (args[key] !== undefined && typeof args[key] !== 'string') return fail('invalid_arguments', `${key} must be a string.`, `Fix ${key}, then call again.`);
    }
    const changeId = typeof args.changeId === 'string' && args.changeId.trim() ? args.changeId.trim() : undefined;
    if (changeId && !CHANGE_ID_RE.test(changeId)) return fail('invalid_arguments', 'changeId is not a change id.', 'Use the changeId from the earlier result, or leave it out for a new change.');
    return {
      set, file, mode, rulesSha256: args.rulesSha256, why, trigger: tool === 'knowledge_propose' ? (triggerRaw as ProposalTrigger) : null,
      content: args.content as string | undefined, edits, from: args.from as string | undefined, toFile: args.toFile as string | undefined,
      toSet: args.toSet as string | undefined, baseSha256: args.baseSha256 as string | undefined, changeId, stageAsIs: args.stageAsIs === true,
    };
  }

  interface Built { plan: ChangePlan; primaryBefore: string | null; primaryAfter: string | null; primaryPath: string; baseSha: string | null; bytes: number }

  /** The candidate for every mode except the set-level ones, before the check's summary refresh. */
  async function buildPlan(parsed: Parsed, target: Target, inspected: InspectResult, source: ReturnType<typeof readImportSource> | null): Promise<Built | Failure> {
    const root = inspected.root;
    const file = parsed.file as string;
    const named = validateFileName(file);
    if (!named.ok) return named;
    const guideTarget = isGuideName(file);
    if (target.isRoot && !guideTarget) return failure('invalid_path', 'The root of the library holds only its GUIDE.md; files belong in a set.', 'Name a set, or create one with knowledge_create_set.');
    if (guideTarget) {
      if (parsed.mode === 'create' || parsed.mode === 'import' || parsed.mode === 'move' || parsed.mode === 'archive') {
        return failure('invalid_arguments', 'GUIDE.md can be edited (edit, replace, append) but not created, imported, moved or archived this way.', 'Use mode edit or replace on the existing guide.');
      }
    } else {
      const reason = generatedFileReason(target.set, file);
      if (reason) return failure('generated_file', `${file} cannot be edited: ${reason}.`, 'Use propose_lesson for an operating rule, or put the knowledge in a file of your own in this set.');
      const type = validateWritableType(file, target.guide, parsed.content ?? null);
      if (type) return type;
    }
    const guideAbsolute = target.guidePath;
    const absoluteFile = guideTarget ? { ok: true as const, absolute: guideAbsolute as string, exists: true } : await resolveInsideSet(target.dir, named.segments);
    if (!absoluteFile.ok) return absoluteFile;
    const current = await readLibraryText(absoluteFile.absolute);
    if (!current.ok) return current;
    const beforeRaw = current.text;
    const primaryPath = relativeToRoot(root, absoluteFile.absolute);
    const view = viewOf(beforeRaw ?? '');
    const files: PlannedFile[] = [];
    let primaryAfter: string | null = null;
    let importSource: ChangePlan['importSource'];
    let effectiveMode = parsed.mode;

    const finish = (after: string | null): void => { primaryAfter = after; };
    switch (parsed.mode) {
      case 'create': {
        if (absoluteFile.exists) return failure('exists', `${file} already exists.`, 'Choose another name, or use mode edit or append to change it.');
        if (typeof parsed.content !== 'string' || !parsed.content) return failure('invalid_arguments', 'content is required for create.', 'Add content, then call again.');
        if (parsed.content.length > writeFileMaxChars()) return failure('result_too_large', `content is over ${writeFileMaxChars().toLocaleString('en-US')} characters for one call.`, 'Create the file with the first part, then add the rest with mode append.');
        finish(restoreView(parsed.content.replace(/\r\n?/g, '\n'), { bom: false, eol: '\n' }));
        break;
      }
      case 'append': {
        if (typeof parsed.content !== 'string' || !parsed.content) return failure('invalid_arguments', 'content is required for append.', 'Add content, then call again.');
        if (parsed.content.length > writeFileMaxChars()) return failure('result_too_large', `content is over ${writeFileMaxChars().toLocaleString('en-US')} characters for one call.`, 'Append in smaller parts.');
        if (beforeRaw === null) { effectiveMode = 'create'; finish(parsed.content.replace(/\r\n?/g, '\n')); break; }
        const joiner = view.lf === '' || view.lf.endsWith('\n') ? '' : '\n';
        finish(restoreView(`${view.lf}${joiner}${parsed.content.replace(/\r\n?/g, '\n')}`, view));
        break;
      }
      case 'edit': {
        if (beforeRaw === null) return failure('file_not_found', `${file} does not exist.`, 'Use mode create for a new file, or knowledge_list for the names.');
        if (!Array.isArray(parsed.edits) || parsed.edits.length === 0) return failure('invalid_arguments', 'edits ([{find, replace}]) is required for edit.', 'Add edits, then call again.');
        const edited = applyEdits(view.lf, parsed.edits.map((edit) => ({ find: String(edit?.find ?? '').replace(/\r\n?/g, '\n'), replace: String(edit?.replace ?? '').replace(/\r\n?/g, '\n') })));
        if (!edited.ok) return edited;
        finish(restoreView(edited.text, view));
        break;
      }
      case 'replace': {
        if (beforeRaw === null) return failure('file_not_found', `${file} does not exist.`, 'Use mode create for a new file.');
        if (typeof parsed.content !== 'string') return failure('invalid_arguments', 'content is required for replace.', 'Add content, then call again.');
        if (!parsed.baseSha256 || parsed.baseSha256.toLowerCase() !== hashText(beforeRaw)) return failure('stale_base', 'baseSha256 is missing or the file changed since you loaded it.', 'knowledge_load the file again and send the sha256 of that load as baseSha256, then retry once.');
        if (parsed.content.length > writeFileMaxChars()) return failure('result_too_large', `content is over ${writeFileMaxChars().toLocaleString('en-US')} characters for one call.`, 'Replace with edits, or write the file in parts with append.');
        finish(restoreView(parsed.content.replace(/\r\n?/g, '\n'), view));
        break;
      }
      case 'import': {
        if (absoluteFile.exists) return failure('exists', `${file} already exists.`, 'Choose another name.');
        if (!source || 'code' in source) return source ? (source as Failure) : failure('invalid_arguments', 'from is required for import.', 'Add from, then call again.');
        if (!Buffer.from(source.text, 'utf8').equals(source.bytes)) return failure('not_text', 'That file is not valid UTF-8 text.', 'Import a text file.');
        importSource = { path: source.path, sha256: source.sha256 };
        finish(source.text);
        break;
      }
      case 'move': {
        if (beforeRaw === null) return failure('file_not_found', `${file} does not exist.`, 'Use knowledge_list for the names.');
        const toName = validateFileName(parsed.toFile ?? '');
        if (!toName.ok) return toName;
        const type = validateWritableType(toName.name, target.guide, null);
        if (type) return type;
        let destDir = target.dir;
        if (parsed.toSet) {
          const other = await library.inspect(parsed.toSet);
          if (!('ok' in other) || other.ok !== true || !other.set) return failure('set_not_found', `No set named "${parsed.toSet.slice(0, 80)}".`, 'Call knowledge_list for the set ids.');
          destDir = other.set.dir;
        }
        const destination = await resolveInsideSet(destDir, toName.segments);
        if (!destination.ok) return destination;
        if (destination.exists) return failure('exists', `${toName.name} already exists.`, 'Choose another name.');
        files.push({ path: primaryPath, before: hashText(beforeRaw), after: null });
        files.push({ path: relativeToRoot(root, destination.absolute), before: null, after: beforeRaw });
        finish(null);
        break;
      }
      case 'archive': {
        if (beforeRaw === null) return failure('file_not_found', `${file} does not exist.`, 'Use knowledge_list for the names.');
        let archived = path.join(target.dir, '_archive', ...named.segments);
        let counter = 2;
        while (await readIfExists(archived).then((bytes) => bytes !== null).catch(() => false)) {
          archived = path.join(target.dir, '_archive', ...named.segments.slice(0, -1), `${stripExtension(named.segments[named.segments.length - 1])}-${counter}${path.extname(file)}`);
          counter += 1;
        }
        files.push({ path: primaryPath, before: hashText(beforeRaw), after: null });
        files.push({ path: relativeToRoot(root, archived), before: null, after: beforeRaw });
        finish(null);
        break;
      }
    }
    if (parsed.mode !== 'move' && parsed.mode !== 'archive') {
      if (primaryAfter === null) return failure('internal_error', 'No candidate was produced.', 'Run knowledge_list and try again.');
      if (Buffer.byteLength(primaryAfter, 'utf8') > MAX_RESULT_BYTES) return failure('result_too_large', 'The result would be larger than 4 MB.', 'Keep the file under 4 MB; use append to add to a new file in parts.');
      if (guideTarget && Buffer.byteLength(primaryAfter, 'utf8') > 256 * 1024) return failure('result_too_large', 'A guide over 256 KB is not read, so this edit is refused.', 'Shorten the change.');
      files.unshift({ path: primaryPath, before: hashText(beforeRaw), after: primaryAfter });
    }
    const bytes = files.reduce((sum, item) => sum + (item.after === null ? 0 : Buffer.byteLength(item.after, 'utf8')), 0);
    const plan: ChangePlan = {
      mode: effectiveMode, set: target.setId, file, files, ...(importSource ? { importSource } : {}),
      summary: `${effectiveMode} ${file}${parsed.toFile ? ` → ${parsed.toFile}` : ''}`,
    };
    return { plan, primaryBefore: beforeRaw, primaryAfter, primaryPath, baseSha: hashText(beforeRaw), bytes };
  }

  // ── plan: the guide's refresh ────────────────────────────────────────────

  interface Refresh { purpose?: string; bullets?: string[] }

  /** Splice the guide's table row and TOC summary for this change; the same plan, the same diff, the same History entry. */
  function withGuideRefresh(plan: ChangePlan, parsed: Parsed, target: Target, inspected: InspectResult, built: Built, refresh: Refresh | undefined): Failure | null {
    if (!target.guide || isGuideName(parsed.file as string) || !target.guidePath) return null;
    const file = parsed.file as string;
    const guidePath = relativeToRoot(inspected.root, target.guidePath);
    let text = target.guideText;
    const purposeFallback = clip((built.primaryAfter ?? built.primaryBefore ?? '').split('\n').map((line) => line.replace(/^\s*(?:#+|[-*>])\s*/, '').trim()).find(Boolean) ?? file, 160);
    const bullets = refresh?.bullets?.length ? refresh.bullets : undefined;
    const dirOf = (name: string) => (name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : '');
    // A row and a summary belong to a file by its name RELATIVE TO THE SET: two files that share a base name in two folders
    // keep their own row and their own summary (R31).
    const names = namesOf(target);
    switch (plan.mode) {
      case 'create':
      case 'import': {
        text = upsertFileRow(text, { file, path: dirOf(file), mechanism: 'On demand', purpose: refresh?.purpose ?? purposeFallback, audience: '' }, names);
        text = setTocSection(text, file, bullets ?? [refresh?.purpose ?? purposeFallback], names);
        break;
      }
      case 'append':
      case 'edit':
      case 'replace': {
        if (bullets && summaryFor(target.guide, file, names)) text = setTocSection(text, file, bullets, names);
        break;
      }
      case 'move': {
        const toFile = parsed.toFile as string;
        if (!parsed.toSet) {
          text = renameFileRow(text, file, toFile, dirOf(toFile), names);
          text = renameTocSection(text, file, toFile, names);
        }
        break;
      }
      case 'archive': {
        text = removeTocSection(removeFileRow(text, file, names), file, names);
        break;
      }
      default:
        break;
    }
    if (text === target.guideText) return null;
    if (rulesDigest(parseGuide(text)) !== target.digest) return failure('internal_error', 'The guide refresh would have changed the guide\'s rules; nothing was changed.', 'Tell the owner if it repeats.');
    plan.files.push({ path: guidePath, before: hashText(target.guideText), after: text });
    return null;
  }

  /** A cross-set move edits both guides: the old one loses the row, the new one gains it. */
  async function withCrossSetGuides(plan: ChangePlan, parsed: Parsed, target: Target, inspected: InspectResult): Promise<Failure | null> {
    if (plan.mode !== 'move' || !parsed.toSet) return null;
    const other = await targetFor(parsed.toSet);
    if ('code' in other && other.ok === false) return other;
    const destination = (other as { target: Target }).target;
    if (destination.setId === target.setId) return null;
    if (!destination.guide || !destination.guidePath || !target.guide || !target.guidePath) return failure('guide_required', 'Both sets need a guide for a move between them.', 'Create the missing guide first.');
    const file = parsed.file as string;
    const toFile = parsed.toFile as string;
    const sourceNames = namesOf(target);
    const destinationNames = namesOf(destination);
    const row = rowFor(target.guide, file, sourceNames);
    const bullets = summaryFor(target.guide, file, sourceNames)?.bullets;
    const oldText = removeTocSection(removeFileRow(target.guideText, file, sourceNames), file, sourceNames);
    let newText = upsertFileRow(destination.guideText, { file: toFile, path: toFile.includes('/') ? toFile.slice(0, toFile.lastIndexOf('/') + 1) : '', mechanism: row?.mechanism || 'On demand', purpose: row?.purpose || toFile, audience: row?.audience ?? '' }, destinationNames);
    newText = setTocSection(newText, toFile, bullets?.length ? bullets : [row?.purpose || toFile], destinationNames);
    plan.files.push({ path: relativeToRoot(inspected.root, target.guidePath), before: hashText(target.guideText), after: oldText });
    plan.files.push({ path: relativeToRoot(inspected.root, destination.guidePath), before: hashText(destination.guideText), after: newText });
    return null;
  }

  // ── check and diff ───────────────────────────────────────────────────────

  /** The text each file of a plan holds now (null when absent), for the diff the owner sees. */
  async function loadBefores(plan: ChangePlan, root: string): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    for (const item of plan.files) {
      const bytes = await readIfExists(path.join(root, ...item.path.split('/'))).catch(() => null);
      map.set(item.path, bytes ? bytes.toString('utf8') : null);
    }
    return map;
  }

  function diffTextOf(plan: ChangePlan, befores: Map<string, string | null>): string {
    const parts: string[] = [];
    for (const item of plan.files) {
      const before = befores.get(item.path) ?? null;
      const label = item.after === null ? `${item.path} (removed)` : before === null ? `${item.path} (new)` : item.path;
      const diff = diffLines(before ?? '', item.after ?? '');
      if (diff.identical) { parts.push(`${label}: no change`); continue; }
      parts.push(renderUnifiedDiff(diff, { label, maxLines: 400 }).text);
    }
    return parts.join('\n\n');
  }

  async function readTied(target: Target, file: string): Promise<Array<{ file: string; text: string }>> {
    if (!target.guide || !target.set) return [];
    const out: Array<{ file: string; text: string }> = [];
    for (const name of tiedFileNames(target.guide, target.set, file)) {
      const member = target.set.files.find((entry) => entry.name === name);
      if (!member) continue;
      const read = await readLibraryText(member.absolute);
      if (read.ok && read.text !== null) out.push({ file: name, text: read.text });
    }
    return out;
  }

  // ── commit ───────────────────────────────────────────────────────────────

  interface CommitMeta {
    actor: 'botboy' | 'owner-via-botboy';
    summary: string;
    changeId?: string;
    notes?: CheckNote[];
    overrode?: string[];
    sources?: string[];
    rulesGuides?: Array<{ path: string; digest: string }>;
    kind: 'write' | 'create_set';
  }

  /** Folders that stay even when empty, next to the categories the root guide names: the analytics set's generated folders. */
  const RESERVED_FOLDERS = ['analytics', 'analytics/presets', 'analytics/lessons'];

  /**
   * After files were taken away (a move, an archive, an Undo of a created file): remove the folders that are now empty, so a
   * set that was undone or archived can be created again and the library shows no empty shell. Never the root, a category or
   * a reserved folder. A leftover folder is only clutter, so nothing here can fail a change (R32).
   */
  async function pruneEmptied(root: string, rootGuidePath: string | null, removedFiles: readonly string[]): Promise<void> {
    if (removedFiles.length === 0) return;
    try {
      const keep = new Set<string>(RESERVED_FOLDERS);
      const text = rootGuidePath ? await readIfExists(rootGuidePath).catch(() => null) : null;
      if (text) for (const category of parseGuide(text.toString('utf8')).categories) keep.add(category.folder.replace(/\/+$/, '').toLowerCase());
      await pruneEmptyFolders(root, removedFiles, keep);
    } catch { /* a folder that stays is not an error */ }
  }

  type CommitResult = { ok: true; historyId: string; written: string[] } | { ok: false; code: 'stale' | 'io' | 'denied' | 'rules_changed' | 'unrecorded'; message: string; nextAction: string };

  /** Write a plan under the per-root lock: re-verify bases, intent record, temp-then-rename, post-write read, History. */
  async function commit(plan: ChangePlan, meta: CommitMeta, expectedRoot?: string, lockHeld = false): Promise<CommitResult> {
    const run = async (): Promise<CommitResult> => {
      const inspected = await library.inspect(ROOT_SET_ID);
      if (!('ok' in inspected) || inspected.ok !== true) return { ok: false, code: 'denied', message: 'The Knowledge folder is not available.', nextAction: 'Open Settings → Knowledge.' };
      const root = inspected.root;
      if (expectedRoot && expectedRoot !== root) return { ok: false, code: 'stale', message: 'The Knowledge folder moved since this change was prepared.', nextAction: 'Ask BotBoy to prepare it again.' };
      await history.reconcile({ force: true });
      // Rules the change was written under must still be the rules.
      for (const guard of meta.rulesGuides ?? []) {
        const bytes = await readIfExists(path.join(root, ...guard.path.split('/'))).catch(() => null);
        if (!bytes || rulesDigest(parseGuide(bytes.toString('utf8'))) !== guard.digest) return { ok: false, code: 'rules_changed', message: 'The guide\'s rules were edited after this change was prepared.', nextAction: 'Ask BotBoy to prepare the change again under the current rules.' };
      }
      for (const pinned of [...(plan.importSource ? [plan.importSource] : []), ...(plan.importSources ?? [])]) {
        if (!importSourceStillMatches(pinned)) return { ok: false, code: 'stale', message: 'A file to import changed since it was staged.', nextAction: 'Ask BotBoy to import it again.' };
      }
      const prepared: Array<{ rel: string; absolute: string; before: Buffer | null; after: Buffer | null }> = [];
      for (const item of plan.files) {
        const absolute = path.join(root, ...item.path.split('/'));
        if (!isInside(root, absolute) || item.path.split('/').some((part) => part === '..' || part.startsWith('.git'))) return { ok: false, code: 'denied', message: 'A path in this change leaves the Knowledge folder.', nextAction: 'Dismiss this change.' };
        // The real parent must stay inside the real root (a link swapped in since staging).
        if (!(await realParentInside(root, absolute))) return { ok: false, code: 'denied', message: 'A folder in this change resolves outside the Knowledge folder.', nextAction: 'Dismiss this change.' };
        const current = await readLibraryText(absolute);
        if (!current.ok) return { ok: false, code: 'denied', message: current.message, nextAction: current.nextAction };
        const currentSha = current.bytes ? sha256Hex(current.bytes) : null;
        if (currentSha !== item.before) return { ok: false, code: 'stale', message: `${item.path} changed since this change was prepared.`, nextAction: 'Ask BotBoy to prepare the change again from the current file.' };
        prepared.push({ rel: item.path, absolute, before: current.bytes, after: item.after === null ? null : Buffer.from(item.after, 'utf8') });
      }
      try {
        await history.begin({ actor: meta.actor, kind: meta.kind, summary: meta.summary, changeId: meta.changeId, files: prepared.map((item) => ({ path: item.rel, before: item.before, after: item.after })) });
      } catch (error) {
        // Nothing has been touched yet: History cannot be prepared (a full disk, a lost folder), so the change is not made.
        return { ok: false, code: 'io', message: `History could not be prepared (${clip(String((error as Error)?.message ?? error), 160)}); nothing was changed.`, nextAction: 'Check the free space on this Mac and Settings → Knowledge, then try again.' };
      }
      const written: typeof prepared = [];
      let rolledBack = true;
      try {
        // Content files first, the guide(s) last, so a failing guide write rolls the content back from its pre-image.
        const ordered = [...prepared].sort((left, right) => Number(isGuideName(left.rel)) - Number(isGuideName(right.rel)));
        for (const item of ordered) {
          if (item.after === null) await fsp.unlink(item.absolute).catch((error: NodeJS.ErrnoException) => { if (error?.code !== 'ENOENT') throw error; });
          else await writeFileAtomic(item.absolute, item.after, { ensureDir: true });
          written.push(item);
        }
        for (const item of written) {
          const now = await readIfExists(item.absolute);
          const expected = item.after;
          if ((now === null) !== (expected === null) || (now && expected && !now.equals(expected))) throw new Error(`${item.rel} did not read back as written`);
          if (expected) {
            const stat = await fsp.lstat(item.absolute);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${item.rel} is not a regular file after writing`);
          }
        }
      } catch (error) {
        for (const item of [...written].reverse()) {
          try {
            if (item.before === null) await fsp.unlink(item.absolute).catch(() => undefined);
            else await writeFileAtomic(item.absolute, item.before, { ensureDir: true });
          } catch { rolledBack = false; /* the next reconcile records whatever is left as an outside edit */ }
        }
        // Nothing is mid-change any more. With every file restored the intent record has nothing to resolve; otherwise it stays.
        await history.abandon({ restored: rolledBack }).catch(() => undefined);
        return { ok: false, code: 'io', message: `The change could not be written (${clip(String((error as Error)?.message ?? error), 160)}); nothing was changed.`, nextAction: 'Check Settings → Knowledge, then try again.' };
      }
      await pruneEmptied(root, inspected.rootGuidePath ?? null, prepared.filter((item) => item.after === null).map((item) => item.rel));
      let entry: Awaited<ReturnType<KnowledgeHistory['record']>>;
      try {
        entry = await history.record({
          actor: meta.actor, kind: meta.kind, summary: meta.summary, changeId: meta.changeId,
          files: prepared.map((item) => ({ path: item.rel, before: item.before, after: item.after })),
          ...(meta.notes?.length ? { checkNotes: meta.notes } : {}), ...(meta.overrode?.length ? { overrode: meta.overrode } : {}), ...(meta.sources?.length ? { sources: meta.sources } : {}),
        });
      } catch (error) {
        // The files ARE written. The intent record is still on disk, so the next reconcile finishes the History entry as recovered.
        library.invalidate();
        library.bump();
        return { ok: false, code: 'unrecorded', message: `The change was written, but History could not record it (${clip(String((error as Error)?.message ?? error), 160)}).`, nextAction: 'Free some space on this Mac; History picks the change up at the next check, so do not repeat it.' };
      }
      library.invalidate();
      library.bump();
      return { ok: true, historyId: entry.id, written: prepared.map((item) => item.rel) };
    };
    return lockHeld ? run() : library.withLock(run);
  }

  function noteOf(item: CheckItem): CheckNote {
    return { tier: item.tier === 'must_fix' ? 'should_fix' : item.tier, ...(item.rule ? { rule: clip(item.rule, 200) } : {}), problem: clip(item.problem, 300), ...(item.fix ? { fix: clip(item.fix, 300) } : {}) };
  }

  function summaryOf(plan: ChangePlan, why: string): string {
    return clip(`${plan.summary}${why ? ` — ${why}` : ''}`, 300);
  }

  // ── the write ────────────────────────────────────────────────────────────

  async function write(args: Record<string, unknown>, context: ToolExecutionContext | undefined, tool: 'knowledge_write' | 'knowledge_propose'): Promise<WriterReply> {
    const parsed = parseWriteArgs(args, tool);
    if ('ok' in parsed) return parsed;
    // Who may call is decided before anything else, and never from a cached reply.
    const denied = authorityFailure(tool, args, context);
    if (denied) return denied;
    const state = requestState(context);
    const key = shortHash(JSON.stringify([tool, parsed.set, parsed.file, parsed.mode, parsed.content, parsed.edits, parsed.from, parsed.toFile, parsed.toSet, parsed.baseSha256, parsed.changeId, parsed.stageAsIs, args.rulesSha256]));
    // An identical NEW call returns the earlier result instead of a second change. A revision of a change (changeId) is the
    // coach loop's business: an unchanged resubmission consumes an attempt there.
    const earlier = parsed.changeId ? undefined : state.replies.get(key);
    if (earlier) return JSON.parse(earlier) as WriterReply;
    const reply = await runWrite(parsed, args, context, tool, state);
    // Only a reply that created or applied a change is replayed; a refusal (guide_not_read ...) must be retryable.
    if (!parsed.changeId && reply.changeId) state.replies.set(key, JSON.stringify(reply));
    return reply;
  }

  async function runWrite(parsed: Parsed, args: Record<string, unknown>, context: ToolExecutionContext | undefined, tool: 'knowledge_write' | 'knowledge_propose', state: NonNullable<ToolExecutionContext['knowledgeRequest']>): Promise<WriterReply> {
    const denied = authorityFailure(tool, args, context);
    if (denied) return denied;
    const resolved = await targetFor(parsed.set);
    if ('ok' in resolved && resolved.ok === false) return fromFailure(resolved);
    const { target, inspected } = resolved as { target: Target; inspected: InspectResult };
    const setLevel = parsed.file === null;
    const file = parsed.file ?? '';
    const guideTarget = !setLevel && isGuideName(file);

    // The change being revised, if any, and who may touch it.
    let existing: KnowledgeChange | null = null;
    if (parsed.changeId) {
      existing = changes.get(parsed.changeId);
      if (!existing) return fail('change_not_found', 'That changeId is unknown or has expired.', 'Start a new change without changeId.');
      const open = state.seenChangeIds.has(existing.id) || (context?.openChangeIds ?? []).includes(existing.id);
      if (!open) return fail('change_not_open', 'That change was not opened in this turn. Only the owner\'s "Ask BotBoy to fix" or Re-draft on its card reopens it.', 'Start a new change without changeId, or ask the owner to reopen the card.');
      const growing = ['append', 'create'];
      const sameMode = existing.mode === parsed.mode || (growing.includes(existing.mode) && growing.includes(parsed.mode));
      if (existing.setName !== target.setId || (existing.file ?? '') !== file || !sameMode) {
        return fail('change_mismatch', 'changeId belongs to a different set, file or mode.', 'Use the same set, file and mode as the change you are revising.');
      }
      if (existing.status === 'applied' || existing.status === 'dismissed' || existing.status === 'expired') return fail('change_closed', `That change is already ${existing.status}.`, 'Start a new change without changeId.');
      if (waitingForOwner(existing, state)) return waitingReply(existing);
    } else if (state.newChanges >= MAX_NEW_CHANGES_PER_REQUEST) {
      return fail('request_cap', `At most ${MAX_NEW_CHANGES_PER_REQUEST} new changes per request.`, 'Stop; tell the owner what is still waiting and ask them to continue in a new message.');
    }

    // Step 0: the receipt, before any content work and before any model call.
    const touches: Array<{ target: Target; file: string; kindOverride?: TargetKind; ownDelivery?: boolean }> = [];
    if (!setLevel) touches.push({ target, file });
    else if (target.guide && !target.isRoot) touches.push({ target, file: GUIDE_FILE_NAME, kindOverride: 'new' });
    if (parsed.toFile && !guideTarget && !parsed.toSet) touches.push({ target, file: parsed.toFile, kindOverride: 'new' });
    let destinationTarget: Target | null = null;
    if (parsed.toSet) {
      const other = await targetFor(parsed.toSet);
      if ('ok' in other && other.ok === false) return fromFailure(other);
      destinationTarget = (other as { target: Target }).target;
      if (destinationTarget.setId !== target.setId) touches.push({ target: destinationTarget, file: parsed.toFile ?? file, kindOverride: 'new', ownDelivery: true });
    }
    const unread = receiptFailure(context, parsed.rulesSha256, touches);
    if (unread) return unread;

    if (setLevel) return setLevelChange(parsed, tool, context, state, target, inspected, destinationTarget);

    // Step 1 and 2: gates and the candidate. A reconcile runs under the per-root lock like every write, so it never sees a
    // commit half done (history.reconcile also skips while this process has a write in flight).
    await library.withLock(() => history.reconcile({ force: true }));
    const source = parsed.mode === 'import' ? readImportSource(parsed.from, inspected.root) : null;
    const built = await buildPlan(parsed, target, inspected, source);
    if ('code' in built && built.ok === false) return fromFailure(built);
    const plan = (built as Built).plan;
    const builtPlan = built as Built;
    // A candidate identical to the file is not a change: no check call, no card, no History entry, no Undo that restores the same bytes.
    if (builtPlan.primaryBefore !== null && builtPlan.primaryAfter !== null && builtPlan.primaryBefore === builtPlan.primaryAfter) {
      return fail('no_change', `That change would leave ${file} exactly as it is.`, 'Nothing to write: tell the owner the file already says this, or change the text first.');
    }
    const crossSet = await withCrossSetGuides(plan, parsed, target, inspected);
    if (crossSet) return fromFailure(crossSet);
    // Both guides of a cross-set move are pinned with the change, so a card re-verifies what a direct apply does (R9).
    plan.rulesGuides = rulesGuidesFor(plan, target, inspected, destinationTarget);

    // The check, with the primary file's diff.
    const primaryDiff = diffLines(builtPlan.primaryBefore ?? '', builtPlan.primaryAfter ?? '');
    const candidateSha = sha256Hex(JSON.stringify(plan.files.map((item) => [item.path, item.after])));
    const attempt = (existing?.attempt ?? 0) + 1;
    const round = existing?.round ?? 1;
    const reopened = Boolean(existing && existing.status !== 'revising');
    const effectiveRound = reopened ? round + 1 : round;
    const effectiveAttempt = reopened ? 1 : attempt;

    // An identical resubmission consumes an attempt with no model call.
    if (existing && existing.status === 'revising' && existing.candidateSha256 === candidateSha) {
      return loopOutcome(existing, existing.items, effectiveAttempt, true, tool, parsed, state, plan, builtPlan, target);
    }

    const tied = guideTarget ? [] : await readTied(target, file);
    const refreshBase: CheckInput = {
      setId: target.setId, guideText: target.guideText, guide: target.guide as ParsedGuide,
      target: { file, purpose: (target.guide && rowFor(target.guide, file, namesOf(target))?.purpose) ?? '' }, mode: plan.mode,
      before: builtPlan.primaryBefore, after: builtPlan.primaryAfter, diff: primaryDiff, tied, guideEdit: guideTarget,
    };
    const outcome = await check.run(refreshBase, { signal: context?.abortSignal });
    const sources = [...new Set([...(existing?.sources ?? []), ...untrustedSourcesOf(context)])];

    if (!outcome.ok) {
      // Held: the change is staged with its plan, never applied unchecked.
      if (!withGuideRefreshSafe(plan, parsed, target, inspected, builtPlan, undefined)) return fail('internal_error', 'The guide refresh failed.', 'Run knowledge_list and tell the owner if it repeats.');
      const befores = await loadBefores(plan, inspected.root);
      const row = saveRow(existing, { target, parsed, plan, builtPlan, tool, candidateSha, round: effectiveRound, attempt: effectiveAttempt, items: [], unresolved: [], notes: [], check: { reason: outcome.reason, message: outcome.message, nextAction: outcome.nextAction }, status: 'held', statusReason: outcome.message, sources, suspicious: false, befores });
      touch(state, row, !existing);
      return { ok: false, status: 'staged', code: 'held_check_unavailable', effect: 'staged', changeId: row.id, message: outcome.message, nextAction: `${outcome.nextAction} The change is saved as a card for the owner; do not say it was applied.`, reason: outcome.reason };
    }

    const musts = outcome.items.filter((item) => item.tier === 'must_fix');
    const all = outcome.items;
    // Guide refresh (summaries) rides the same plan.
    const refreshFailure = withGuideRefresh(plan, parsed, target, inspected, builtPlan, outcome.summaryUpdate);
    if (refreshFailure) return fromFailure(refreshFailure);
    if (plan.files.reduce((sum, item) => sum + (item.after === null ? 0 : Buffer.byteLength(item.after, 'utf8')), 0) > MAX_PLAN_BYTES) {
      return fail('result_too_large', 'This change is too large to stage (over 2 MB of text in total).', 'Split it: create the file with a first part, then append the rest in chunks.');
    }
    const befores = await loadBefores(plan, inspected.root);
    const stagedNow = parsed.stageAsIs || effectiveAttempt >= MAX_ATTEMPTS;
    if (musts.length > 0 && !stagedNow) {
      const row = saveRow(existing, { target, parsed, plan, builtPlan, tool, candidateSha, round: effectiveRound, attempt: effectiveAttempt, items: all, unresolved: [], notes: [], check: { coverage: outcome.coverage }, status: 'revising', statusReason: null, sources, suspicious: outcome.suspiciousDirective, befores });
      touch(state, row, !existing);
      if (!existing) state.newChanges += 1;
      return needsChanges(row, all, effectiveAttempt, tool === 'knowledge_write');
    }
    if (musts.length > 0) {
      const row = saveRow(existing, { target, parsed, plan, builtPlan, tool, candidateSha, round: effectiveRound, attempt: effectiveAttempt, items: all, unresolved: all.filter((item) => item.tier !== 'note'), notes: all.filter((item) => item.tier === 'note'), check: { coverage: outcome.coverage }, status: 'staged', statusReason: parsed.stageAsIs ? 'Staged as is, at the request of the model.' : `The guide check still found a breach after ${MAX_ATTEMPTS} attempts.`, sources, suspicious: outcome.suspiciousDirective, befores });
      touch(state, row, !existing);
      if (!existing) state.newChanges += 1;
      return stagedReply(row, 'unresolved');
    }

    // No must_fix: the decision between a direct apply and a card.
    const notes = all.filter((item) => item.tier !== 'must_fix');
    const guideRequirement = guideTarget || target.isRoot;
    // The follow-up sentence of "Ask BotBoy to fix" reopens one card; it is not the owner's request for any other change (R35).
    const reopenedByOwner = existing !== null && (context?.openChangeIds ?? []).includes(existing.id);
    const intent = (context?.intentFromCardOnly !== true || reopenedByOwner) && ownerAskedForEdit(context?.currentUserMessage ?? '', {
      setNames: target.setNames, keywords: target.keywords, file, importBase: parsed.from ? path.basename(parsed.from) : undefined, guideTarget: guideRequirement && guideTarget,
    });
    // Born in THIS request: a change the owner reopened (or one from an earlier turn) is never applied directly, however often it
    // is revised, because the model's revisions of it are not what the owner asked for in this message.
    const bornThisTurn = !existing || state.bornIds.has(existing.id);
    const tainted = turnIsTainted(context, { guideTarget });
    const direct = tool === 'knowledge_write' && context?.callerKind === 'interactive' && args.ownerRequested === true && !tainted && intent
      && !outcome.suspiciousDirective && bornThisTurn && !parsed.stageAsIs;
    const row = saveRow(existing, { target, parsed, plan, builtPlan, tool, candidateSha, round: effectiveRound, attempt: effectiveAttempt, items: all, unresolved: [], notes, check: { coverage: outcome.coverage }, status: direct ? 'revising' : 'staged', statusReason: null, sources, suspicious: outcome.suspiciousDirective, befores });
    touch(state, row, !existing);
    if (!existing) state.newChanges += 1;
    if (!direct) {
      const reasons: string[] = [];
      if (tool === 'knowledge_propose') reasons.push('proposal');
      else {
        if (tainted) reasons.push('untrusted');
        if (!intent) reasons.push('intent');
        if (outcome.suspiciousDirective) reasons.push('suspicious');
        if (!bornThisTurn) reasons.push('left_its_turn');
        if (parsed.stageAsIs) reasons.push('stage_as_is');
      }
      return stagedReply(row, reasons.join(',') || 'approval');
    }
    const committed = await commit(plan, {
      actor: 'owner-via-botboy', kind: 'write', summary: summaryOf(plan, parsed.why), changeId: row.id, notes: notes.map(noteOf),
      rulesGuides: plan.rulesGuides, sources: row.sources,
    });
    return appliedOrStale(row, committed, notes, outcome.coverage);
  }

  /** A held change still carries the server's guide refresh (without model summaries), so Retry check has a full plan. */
  function withGuideRefreshSafe(plan: ChangePlan, parsed: Parsed, target: Target, inspected: InspectResult, built: Built, refresh: Refresh | undefined): boolean {
    return withGuideRefresh(plan, parsed, target, inspected, built, refresh) === null;
  }

  function rulesGuidesFor(plan: ChangePlan, target: Target, inspected: InspectResult, destination: Target | null): Array<{ path: string; digest: string }> {
    const out: Array<{ path: string; digest: string }> = [];
    if (target.guidePath && target.digest) out.push({ path: relativeToRoot(inspected.root, target.guidePath), digest: target.digest });
    if (destination?.guidePath && destination.digest && destination.setId !== target.setId) out.push({ path: relativeToRoot(inspected.root, destination.guidePath), digest: destination.digest });
    void plan;
    return out;
  }

  interface RowInput {
    target: Target; parsed: Parsed; plan: ChangePlan; builtPlan: Built; tool: WriterTool; candidateSha: string; round: number; attempt: number;
    items: CheckItem[]; unresolved: CheckItem[]; notes: CheckItem[]; check: KnowledgeChange['check']; status: KnowledgeChange['status']; statusReason: string | null;
    sources: string[]; suspicious: boolean; befores: Map<string, string | null>;
    /** Set by saveRow itself from the stored row: a revision never changes who the change came from. */
    existingOrigin?: KnowledgeChange['origin'];
  }

  function saveRow(existing: KnowledgeChange | null, rowInput: RowInput): KnowledgeChange {
    const input: RowInput = existing ? { ...rowInput, existingOrigin: existing.origin } : rowInput;
    const diffText = diffTextOf(input.plan, input.befores);
    const common = {
      plan: input.plan, baseSha256: input.builtPlan.baseSha, rulesSha256: input.target.digest ?? '', diffText, why: input.parsed.why, trigger: input.parsed.trigger,
      origin: input.existingOrigin ?? (input.tool === 'knowledge_propose' ? ('botboy_proposal' as const) : ('owner_request' as const)), sources: input.sources, candidateSha256: input.candidateSha,
      items: input.items, unresolved: input.unresolved, notes: input.notes, check: input.check, status: input.status, statusReason: input.statusReason, suspicious: input.suspicious,
      round: input.round, attempt: input.attempt,
    };
    if (existing) return changes.update(existing.id, common) as KnowledgeChange;
    return changes.insert({ setName: input.target.setId, kind: 'write', mode: input.plan.mode, file: input.parsed.file, ...common });
  }

  function needsChanges(row: KnowledgeChange, items: CheckItem[], attempt: number, ownerRequested: boolean): WriterReply {
    const left = Math.max(0, MAX_ATTEMPTS - attempt);
    const shown = items.slice(0, 8).map((item) => ({
      tier: item.tier, rule: item.rule, where: item.where, problem: item.problem, evidence: item.evidence, fix: item.fix, ...(item.edits ? { edits: item.edits } : {}), attempt,
    }));
    return {
      ok: false, status: 'needs_changes', code: 'needs_changes', effect: 'none', changeId: row.id, attempt, attemptsLeft: left, items: shown,
      message: `The guide check found ${items.filter((item) => item.tier === 'must_fix').length} breach(es) to fix${items.some((item) => item.tier === 'should_fix') ? ' and some things worth fixing in the same revision' : ''}. Attempt ${attempt} of ${MAX_ATTEMPTS}.`,
      nextAction: (row.kind === 'create_set'
        ? `Call knowledge_create_set again with changeId "${row.id}", the same name, kind and description (change them only where an item says so), rulesSha256, and ONE revised request that fixes every item (for example another category, or files without the flagged text).`
        : `Call the same tool again with changeId "${row.id}", the same set, file and mode, rulesSha256, and ONE revised ${row.mode === 'edit' ? 'edits list' : 'content'} that fixes every item (ready "edits" in an item can be applied as they are).`)
        + ` ${left === 0 ? 'This was the last attempt.' : `${left} attempt${left === 1 ? '' : 's'} left.`}`
        + (ownerRequested ? ' If the owner\'s request itself needs this text, call again with stageAsIs: true, tell the owner which rule it conflicts with (quote it) and offer the compliant version or a proposal to change the rule.' : ''),
    };
  }

  function loopOutcome(row: KnowledgeChange, items: CheckItem[], attempt: number, repeated: boolean, tool: WriterTool, parsed: Parsed, state: NonNullable<ToolExecutionContext['knowledgeRequest']>, plan: ChangePlan, built: Built, target: Target): WriterReply {
    void built; void plan; void target; void parsed; void repeated;
    const musts = items.filter((item) => item.tier === 'must_fix');
    if (attempt >= MAX_ATTEMPTS && musts.length > 0) {
      const staged = changes.update(row.id, { status: 'staged', attempt, unresolved: items.filter((item) => item.tier !== 'note'), statusReason: `The guide check still found a breach after ${MAX_ATTEMPTS} attempts.` }) as KnowledgeChange;
      state.seenChangeIds.add(row.id);
      return stagedReply(staged, 'unresolved');
    }
    const next = changes.update(row.id, { attempt }) as KnowledgeChange;
    state.seenChangeIds.add(row.id);
    return {
      ...needsChanges(next, items, attempt, tool === 'knowledge_write'),
      message: `Nothing changed since the last attempt, so the guide check was not run again. Attempt ${attempt} of ${MAX_ATTEMPTS}. Fix the items below.`,
    };
  }

  function stagedReply(row: KnowledgeChange, reason: string): WriterReply {
    const untrusted = row.sources.length > 0;
    return ok({
      status: 'staged', code: 'staged_for_approval', effect: 'staged', changeId: row.id, reason,
      message: row.unresolved.length > 0
        ? 'The change was not applied: the guide check still has open items. It is saved as a card the owner can apply anyway, dismiss, or ask you to fix.'
        : `The change is saved as a card for the owner's approval${untrusted ? ` (derived from ${sourceLabel(row.sources)}, so it never applies by itself)` : ''}. It is NOT applied yet.`,
      nextAction: 'Tell the owner a card is waiting in this chat and in Settings → Knowledge; do not say the file was updated.',
      ...(row.unresolved.length > 0 ? { unresolved: row.unresolved.slice(0, 8).map((item) => ({ tier: item.tier, rule: item.rule, problem: item.problem, fix: item.fix })) } : {}),
    });
  }

  function appliedOrStale(row: KnowledgeChange, committed: CommitResult, notes: CheckItem[], coverage: string): WriterReply {
    if (!committed.ok && committed.code === 'unrecorded') {
      // The file changed; only the History line is missing. The change is done, so it must not be offered again.
      changes.update(row.id, { status: 'applied', statusReason: committed.message });
      return fail('internal_error', committed.message, `${committed.nextAction} Tell the owner the file was changed.`, { changeId: row.id, effect: 'unknown' });
    }
    if (!committed.ok) {
      // A write that failed on disk stays a card the owner can try again; a base or rules change makes it stale.
      changes.update(row.id, { status: committed.code === 'io' ? 'staged' : 'stale', statusReason: committed.message });
      return fail(committed.code === 'stale' || committed.code === 'rules_changed' ? 'stale_base' : committed.code === 'denied' ? 'invalid_path' : 'internal_error', committed.message, committed.nextAction, { changeId: row.id });
    }
    const applied = changes.update(row.id, { status: 'applied', historyId: committed.historyId, notes }) as KnowledgeChange;
    return {
      ok: true, status: 'applied', effect: 'applied', changeId: applied.id, message: `Applied: ${row.plan?.summary ?? row.mode}. ${coverage}.`,
      nextAction: 'Tell the owner what changed; Settings → Knowledge → History has the diff and an Undo.',
      diffExcerpt: clip(row.diffText, 3_000), notes: notes.map((item) => ({ tier: item.tier, problem: item.problem, fix: item.fix })), checkedAgainst: coverage, historyId: committed.historyId, files: committed.written,
      undo: 'Settings → Knowledge → History (Undo on the latest change)',
    };
  }

  // ── set-level move and archive (always a card) ───────────────────────────

  async function setLevelChange(parsed: Parsed, tool: WriterTool, context: ToolExecutionContext | undefined, state: NonNullable<ToolExecutionContext['knowledgeRequest']>, target: Target, inspected: InspectResult, destination: Target | null): Promise<WriterReply> {
    void destination;
    if (target.isRoot || !target.set) return fail('invalid_arguments', 'The root cannot be moved or archived as a set.', 'Name a set.');
    if (target.set.reserved) return fail('generated_file', 'The built-in analytics set cannot be moved or archived.', 'Move or archive the files inside it, or the owner does it in Finder.');
    const root = inspected.root;
    const setRel = relativeToRoot(root, target.dir);
    let to: string;
    if (parsed.mode === 'archive') {
      const stamp = new Date().toISOString().slice(0, 10);
      to = `_archive/${setRel.replace(/\//g, '-')}-${stamp}`;
    } else {
      const toSet = typeof parsed.toSet === 'string' ? parsed.toSet.trim().replace(/^\/+|\/+$/g, '') : '';
      const named = validateFileName(`${toSet}/x`);
      if (!toSet || !named.ok) return fail('invalid_arguments', 'toSet must name the new folder of the set (for example "research/garden").', 'Fix toSet, then call again.');
      to = toSet;
    }
    const absoluteTo = path.join(root, ...to.split('/'));
    if (!isInside(root, absoluteTo)) return fail('invalid_path', 'The destination leaves the Knowledge folder.', 'Choose a folder inside it.');
    if (await fsp.lstat(absoluteTo).then(() => true).catch(() => false)) return fail('exists', `${to} already exists.`, 'Choose another destination.');
    const entries = target.set.files.map((entry) => entry.absolute);
    if (target.guidePath) entries.push(target.guidePath);
    if (entries.length > MAX_SET_LEVEL_FILES) return fail('result_too_large', `This set has more than ${MAX_SET_LEVEL_FILES} files, too many to move as one change.`, 'The owner moves it in Finder.');
    const files: PlannedFile[] = [];
    const befores = new Map<string, string | null>();
    let total = 0;
    for (const absolute of entries) {
      const read = await readLibraryText(absolute);
      if (!read.ok) return fromFailure(read);
      if (read.text === null) continue;
      total += read.bytes?.length ?? 0;
      if (total > MAX_SET_LEVEL_BYTES) return fail('result_too_large', 'This set is too large to move as one change.', 'The owner moves it in Finder.');
      const rel = relativeToRoot(root, absolute);
      const dest = `${to}/${rel.slice(setRel.length + 1)}`;
      files.push({ path: rel, before: hashText(read.text), after: null });
      files.push({ path: dest, before: null, after: read.text });
      befores.set(rel, read.text);
    }
    const plan: ChangePlan = { mode: parsed.mode, set: target.setId, file: null, files, summary: `${parsed.mode === 'archive' ? 'archive' : 'move'} set ${target.setId} → ${to}` };
    const sources = [...new Set(untrustedSourcesOf(context))];
    const row = changes.insert({
      setName: target.setId, kind: 'write', mode: parsed.mode, file: null, plan, baseSha256: null, rulesSha256: target.digest ?? '',
      diffText: `${plan.summary}\n${files.filter((item) => item.after === null).map((item) => `- ${item.path}`).join('\n')}`, why: parsed.why, trigger: parsed.trigger,
      origin: tool === 'knowledge_propose' ? 'botboy_proposal' : 'owner_request', sources, candidateSha256: sha256Hex(JSON.stringify(files.map((item) => [item.path, item.after]))),
      status: 'staged', check: { coverage: 'a whole-set change is never checked by a model; the owner reviews it' },
    });
    touch(state, row, true);
    state.newChanges += 1;
    return stagedReply(row, 'set_level');
  }

  // ── create set ───────────────────────────────────────────────────────────

  /** The check on a created set's guide only looks for breaches of the root's placement rules and for secrets (also Retry check). */
  function checkNewSetGuide(rootGuideText: string, rootGuide: ParsedGuide, folderId: string, guideText: string, signal?: AbortSignal): ReturnType<GuideCheck['run']> {
    const synthetic = { ...rootGuide, guardrails: [...rootGuide.guardrails, ...rootGuide.placementRules] };
    return check.run({
      setId: ROOT_SET_ID, guideText: rootGuideText, guide: synthetic, target: { file: `${folderId}/${GUIDE_FILE_NAME}`, purpose: '' }, mode: 'create_set',
      before: null, after: guideText, diff: diffLines('', guideText), tied: [], guideEdit: false,
    }, { signal });
  }

  const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const KIND_CATEGORY: Partial<Record<SetKind, string>> = { analytics: 'analytics', memory: 'memory', product: 'product', research: 'research' };

  async function createSet(args: Record<string, unknown>, context: ToolExecutionContext | undefined): Promise<WriterReply> {
    const denied = authorityFailure('knowledge_create_set', args, context);
    if (denied) return denied;
    const state = requestState(context);
    const key = shortHash(JSON.stringify(['create_set', args.name, args.kind, args.description, args.keywords, args.category, args.files, args.adopt, args.addCategory, args.changeId, args.rulesSha256]));
    const revising = typeof args.changeId === 'string' && args.changeId.length > 0;
    const earlier = revising ? undefined : state.replies.get(key);
    if (earlier) return JSON.parse(earlier) as WriterReply;
    const reply = await runCreateSet(args, context, state);
    if (!revising && reply.changeId) state.replies.set(key, JSON.stringify(reply));
    return reply;
  }

  async function runCreateSet(args: Record<string, unknown>, context: ToolExecutionContext | undefined, state: NonNullable<ToolExecutionContext['knowledgeRequest']>): Promise<WriterReply> {
    const denied = authorityFailure('knowledge_create_set', args, context);
    if (denied) return denied;
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const description = typeof args.description === 'string' ? args.description.trim().slice(0, 400) : '';
    const kind = (typeof args.kind === 'string' ? args.kind : 'generic') as SetKind;
    if (!name || name.length > 80 || !slugOf(name)) return fail('invalid_arguments', 'name is required (a short topic name, at most 80 characters).', 'Fix name, then call again.');
    if (!['analytics', 'product', 'research', 'memory', 'generic'].includes(kind)) return fail('invalid_arguments', 'kind must be analytics, product, research, memory or generic.', 'Fix kind, then call again.');
    if (!description) return fail('invalid_arguments', 'description is required (one line on what the set holds).', 'Add description, then call again.');
    const keywords = Array.isArray(args.keywords) ? (args.keywords as unknown[]).filter((word): word is string => typeof word === 'string').slice(0, 12) : [];
    if (args.changeId !== undefined && (typeof args.changeId !== 'string' || (args.changeId.trim() !== '' && !CHANGE_ID_RE.test(args.changeId.trim())))) {
      return fail('invalid_arguments', 'changeId is not a change id.', 'Use the changeId from the earlier result, or leave it out for a new set.');
    }
    const existingChange = typeof args.changeId === 'string' && CHANGE_ID_RE.test(args.changeId) ? changes.get(args.changeId) : null;
    if (typeof args.changeId === 'string' && args.changeId && !existingChange) return fail('change_not_found', 'That changeId is unknown or has expired.', 'Start again without changeId.');
    if (existingChange && !(state.seenChangeIds.has(existingChange.id) || (context?.openChangeIds ?? []).includes(existingChange.id))) return fail('change_not_open', 'That change was not opened in this turn.', 'Start again without changeId.');
    if (existingChange && waitingForOwner(existingChange, state)) return waitingReply(existingChange);
    if (!existingChange && state.newChanges >= MAX_NEW_CHANGES_PER_REQUEST) return fail('request_cap', `At most ${MAX_NEW_CHANGES_PER_REQUEST} new changes per request.`, 'Stop; tell the owner what is still waiting.');

    const inspected = await library.inspect(ROOT_SET_ID);
    if (!('ok' in inspected) || inspected.ok !== true) { const bad = inspected as { code: string; message: string; nextAction: string }; return fail(bad.code, bad.message, bad.nextAction); }
    const root = inspected.root;
    // The root guide's digest is the receipt; the embedded seed stands in when the owner removed the root guide.
    const rootGuideBytes = inspected.rootGuidePath ? await readIfExists(inspected.rootGuidePath).catch(() => null) : null;
    const rootGuideText = rootGuideBytes ? rootGuideBytes.toString('utf8') : ROOT_GUIDE_SEED;
    const rootGuide = parseGuide(rootGuideText);
    const rootTarget: Target = {
      isRoot: true, setId: ROOT_SET_ID, kind: 'generic', name: 'Knowledge root', dir: root, guidePath: inspected.rootGuidePath, guideText: rootGuideText, guide: rootGuide,
      digest: rulesDigest(rootGuide), writable: true, set: null, setNames: [], keywords: [],
    };
    const unread = receiptFailure(context, args.rulesSha256, [{ target: rootTarget, file: GUIDE_FILE_NAME, kindOverride: 'new' }]);
    if (unread) return unread;

    // Where the set goes.
    const categories: GuideCategory[] = inspected.categories;
    const wantedCategory = typeof args.category === 'string' && args.category.trim() ? args.category.trim().replace(/\/+$/, '') : (KIND_CATEGORY[kind] ?? '');
    let category = '';
    let categoryRow: GuideCategory | undefined;
    if (wantedCategory) {
      categoryRow = categories.find((entry) => entry.folder.toLowerCase() === wantedCategory.toLowerCase());
      if (!categoryRow && args.addCategory !== true) {
        return fail('invalid_arguments', `"${wantedCategory}" is not a category in the root guide (${categories.map((entry) => entry.folder).join(', ') || 'none'}).`, 'Use one of those, leave category out, or call again with addCategory: true to add this one in the same change.');
      }
      const clean = validateFileName(`${wantedCategory}/x`);
      if (!clean.ok) return fromFailure(clean);
      category = categoryRow?.folder ?? wantedCategory;
    }
    const slug = slugOf(name);
    const folderId = category ? `${category}/${slug}` : slug;
    // presets/ and lessons/ of the built-in analytics set are generated and listed as files of that set; a GUIDE.md there would be listed as a preset.
    const lowerFolder = folderId.toLowerCase();
    if (RESERVED_SET_FOLDERS.some((reserved) => lowerFolder === reserved || lowerFolder.startsWith(`${reserved}/`))) {
      return fail('reserved_name', `${folderId} is a built-in folder of the analytics set (its presets and lessons are generated), so it cannot be a set.`, 'Choose another name; put the knowledge in a file of the analytics set or in a set of its own.');
    }
    const folderAbsolute = path.join(root, ...folderId.split('/'));
    if (!isInside(root, folderAbsolute)) return fail('invalid_path', 'The set\'s folder would leave the Knowledge folder.', 'Choose another name.');

    const existingFolder = inspected.sets.find((entry) => entry.id.toLowerCase() === folderId.toLowerCase());
    const adopt = args.adopt === true;
    const folderExists = await fsp.lstat(folderAbsolute).then(() => true).catch(() => false);
    if (folderExists && !adopt) return fail('exists', `${folderId} already exists.`, 'Choose another name, or call again with adopt: true to give the existing folder a guide.');
    if (existingFolder?.hasGuide) return fail('exists', `${folderId} already has a guide.`, 'Edit it with knowledge_write instead.');
    if (adopt && !folderExists) return fail('set_not_found', `There is no folder ${folderId} to adopt.`, 'Create the set without adopt, or name the existing folder.');

    // Initial files: given content, an import, or (adopt) what the folder already holds.
    const given = Array.isArray(args.files) ? (args.files as Array<Record<string, unknown>>).slice(0, 40) : [];
    const planFiles: PlannedFile[] = [];
    const draftFiles: Array<{ name: string; text?: string; purpose?: string }> = [];
    const importSources: Array<{ path: string; sha256: string }> = [];
    const befores = new Map<string, string | null>();
    if (adopt && existingFolder) {
      for (const member of existingFolder.files.slice(0, 80)) {
        const read = await readLibraryText(member.absolute);
        draftFiles.push({ name: member.name, ...(read.ok && read.text ? { text: read.text } : {}) });
      }
    }
    for (const item of given) {
      const named = validateFileName(item.name);
      if (!named.ok) return fromFailure(named);
      const type = validateWritableType(named.name, null, typeof item.content === 'string' ? item.content : null);
      if (type) return fromFailure(type);
      let text: string;
      if (typeof item.from === 'string') {
        const imported = readImportSource(item.from, root);
        if ('code' in imported && imported.ok === false) return fromFailure(imported);
        const src = imported as Exclude<ReturnType<typeof readImportSource>, Failure>;
        if (!Buffer.from(src.text, 'utf8').equals(src.bytes)) return fail('not_text', 'An imported file is not valid UTF-8 text.', 'Import text files only.');
        text = src.text;
        importSources.push({ path: src.path, sha256: src.sha256 });
      } else if (typeof item.content === 'string' && item.content) {
        if (item.content.length > writeFileMaxChars()) return fail('result_too_large', `${named.name}'s content is over ${writeFileMaxChars().toLocaleString('en-US')} characters.`, 'Create the set with a smaller first part and append the rest later.');
        text = item.content.replace(/\r\n?/g, '\n');
      } else {
        return fail('invalid_arguments', `files[].${named.name} needs content or from.`, 'Add content or from, then call again.');
      }
      if (existingFolder?.files.some((member) => member.name.toLowerCase() === named.name.toLowerCase())) return fail('exists', `${named.name} already exists in ${folderId}.`, 'Choose another file name.');
      const target = relativeToRoot(root, path.join(folderAbsolute, ...named.segments));
      planFiles.push({ path: target, before: null, after: text });
      draftFiles.push({ name: named.name, text });
      befores.set(target, null);
    }
    // A credential in an initial file is found here, by code, before anything is drafted or sent: the model gets a fixable list.
    const secretFindings = planFiles.flatMap((item) => (item.after ? secretItems(item.path, item.after) : []));
    if (secretFindings.length > 0) {
      const attemptNo = (existingChange?.attempt ?? 0) + 1;
      const earlyPlan: ChangePlan = { mode: 'create_set', set: folderId, file: null, files: planFiles, summary: `create set ${folderId} (${kind})` };
      const status = attemptNo >= MAX_ATTEMPTS || args.stageAsIs === true ? 'staged' : 'revising';
      const common = {
        plan: earlyPlan, baseSha256: null, rulesSha256: rootTarget.digest ?? '', diffText: '', why: description, trigger: null, origin: 'owner_request' as const,
        sources: [...new Set([...(existingChange?.sources ?? []), ...untrustedSourcesOf(context)])], candidateSha256: sha256Hex(JSON.stringify(planFiles.map((item) => [item.path, item.after]))),
        round: existingChange?.round ?? 1, attempt: attemptNo, status: status as KnowledgeChange['status'], items: secretFindings, unresolved: status === 'staged' ? secretFindings : [], check: { coverage: 'not sent to a model: a file contains a secret format' },
        statusReason: status === 'staged' ? 'A file still contains a secret format.' : null,
      };
      const row = existingChange
        ? changes.update(existingChange.id, common) as KnowledgeChange
        : changes.insert({ setName: folderId, kind: 'create_set', mode: 'create_set', file: null, ...common });
      touch(state, row, !existingChange);
      if (!existingChange) state.newChanges += 1;
      return status === 'revising' ? needsChanges(row, secretFindings, attemptNo, true) : stagedReply(row, 'unresolved');
    }

    // The guide: drafted by the model from the closest template, then checked against the root guide's placement rules.
    const draft = await deps.drafter.draft({ name, kind, description, keywords, files: draftFiles, placementRules: rootGuide.placementRules }, { signal: context?.abortSignal });
    if (!draft.ok) return fail('draft_unavailable', draft.message, draft.nextAction, { reason: draft.reason });
    const guidePath = relativeToRoot(root, path.join(folderAbsolute, GUIDE_FILE_NAME));
    planFiles.push({ path: guidePath, before: null, after: draft.guideText });
    befores.set(guidePath, null);
    if (categoryRow === undefined && category && args.addCategory === true) {
      const rootGuidePathRel = inspected.rootGuidePath ? relativeToRoot(root, inspected.rootGuidePath) : null;
      if (rootGuidePathRel && rootGuideBytes) {
        const nextRoot = addCategoryRow(rootGuideText, { folder: category, holds: description, kind });
        if (nextRoot !== rootGuideText) { planFiles.push({ path: rootGuidePathRel, before: hashText(rootGuideText), after: nextRoot }); befores.set(rootGuidePathRel, rootGuideText); }
      }
    }
    const plan: ChangePlan = {
      mode: 'create_set', set: folderId, file: null, files: planFiles, ...(importSources.length ? { importSources } : {}),
      summary: `create set ${folderId} (${kind}) with ${draftFiles.length} file${draftFiles.length === 1 ? '' : 's'}`,
    };
    if (planFiles.reduce((sum, item) => sum + (item.after === null ? 0 : Buffer.byteLength(item.after, 'utf8')), 0) > MAX_PLAN_BYTES) return fail('result_too_large', 'The new set is too large to stage in one change.', 'Create it with fewer files and add the rest later.');

    const candidateSha = sha256Hex(JSON.stringify(planFiles.map((item) => [item.path, item.after])));
    const attempt = (existingChange?.attempt ?? 0) + 1;
    const outcome = await checkNewSetGuide(rootGuideText, rootGuide, folderId, draft.guideText, context?.abortSignal);
    const sources = [...new Set([...(existingChange?.sources ?? []), ...untrustedSourcesOf(context)])];
    const base = {
      setName: folderId, kind: 'create_set' as const, mode: 'create_set', file: null, plan, baseSha256: null, rulesSha256: rootTarget.digest ?? '', diffText: diffTextOf(plan, befores),
      why: typeof args.why === 'string' ? args.why.slice(0, 600) : description, trigger: null, origin: 'owner_request' as const, sources, candidateSha256: candidateSha, round: existingChange?.round ?? 1,
    };
    const save = (patch: Partial<KnowledgeChange> & { status: KnowledgeChange['status'] }) =>
      (existingChange ? changes.update(existingChange.id, { ...base, ...patch }) as KnowledgeChange : changes.insert({ ...base, attempt, ...patch }));
    if (!outcome.ok) {
      const row = save({ status: 'held', attempt, check: { reason: outcome.reason, message: outcome.message, nextAction: outcome.nextAction }, statusReason: outcome.message });
      touch(state, row, !existingChange);
      if (!existingChange) state.newChanges += 1;
      return { ok: false, status: 'staged', code: 'held_check_unavailable', effect: 'staged', changeId: row.id, message: outcome.message, nextAction: `${outcome.nextAction} The new set is saved as a card for the owner; do not say it was created.` };
    }
    const musts = outcome.items.filter((item) => item.tier === 'must_fix');
    if (musts.length > 0 && attempt < MAX_ATTEMPTS && args.stageAsIs !== true) {
      const row = save({ status: 'revising', attempt, items: outcome.items, check: { coverage: outcome.coverage } });
      touch(state, row, !existingChange);
      if (!existingChange) state.newChanges += 1;
      return needsChanges(row, outcome.items, attempt, true);
    }
    const row = save({
      status: 'staged', attempt, items: outcome.items, unresolved: musts.length > 0 ? outcome.items.filter((item) => item.tier !== 'note') : [], notes: outcome.items.filter((item) => item.tier !== 'must_fix'),
      check: { coverage: `${outcome.coverage}; ${draft.coverage}` }, statusReason: musts.length > 0 ? 'The guide check still found a breach.' : null, suspicious: outcome.suspiciousDirective,
    });
    touch(state, row, !existingChange);
    if (!existingChange) state.newChanges += 1;
    return stagedReply(row, 'create_set');
  }

  // ── the owner's click ────────────────────────────────────────────────────

  function planTextIssues(plan: ChangePlan): string[] {
    const kinds: string[] = [];
    for (const item of plan.files) if (item.after !== null && detectSecrets(item.after).length > 0) kinds.push(item.path);
    return kinds;
  }

  /**
   * The owner's click. The whole decision runs under the per-root lock and reads the change INSIDE it, so two clicks on one card
   * cannot both pass the status check: the second finds `applied` and answers `change_closed` (R7).
   */
  function applyStaged(changeId: string, options: ApplyOptions = {}): Promise<ApplyResult> {
    return library.withLock(() => applyStagedLocked(changeId, options));
  }

  async function applyStagedLocked(changeId: string, options: ApplyOptions = {}): Promise<ApplyResult> {
    const change = changes.get(changeId);
    if (!change) return { ok: false, code: 'change_not_found', message: 'That change is unknown or has expired.', nextAction: 'Ask BotBoy to prepare it again.', status: 404 };
    if (change.status === 'applied' || change.status === 'dismissed' || change.status === 'expired') return { ok: false, code: 'change_closed', message: `That change is already ${change.status}.`, nextAction: 'Nothing to do.', status: 409, change };
    if (change.status === 'held') return { ok: false, code: 'held_check_unavailable', message: 'The guide check could not run for this change. It cannot be applied unchecked.', nextAction: 'Use Retry check (Settings → AI model must have a Document writing model), or Dismiss.', status: 409, change };
    if (change.status === 'stale') return { ok: false, code: 'stale_base', message: 'The file or the guide changed after this was prepared.', nextAction: 'Use Re-draft so BotBoy prepares it again, or Dismiss.', status: 409, change };
    if (change.status === 'revising') return { ok: false, code: 'change_not_ready', message: 'BotBoy is still revising this change.', nextAction: 'Wait a moment, or dismiss it.', status: 409, change };
    const plan = change.plan;
    if (!plan) return { ok: false, code: 'change_not_found', message: 'This change has nothing left to apply.', nextAction: 'Dismiss it.', status: 409, change };
    // The deterministic gates are absolute for every route, the click included.
    const leaking = planTextIssues(plan);
    if (leaking.length > 0 || change.unresolved.some((item) => item.source === 'code')) {
      return { ok: false, code: 'secret_in_content', message: `${leaking[0] ?? 'This change'} contains what looks like a credential. BotBoy never writes credentials into the library.`, nextAction: 'Dismiss it and ask BotBoy to leave the credential out.', status: 409, change };
    }
    const musts = change.unresolved.filter((item) => item.tier === 'must_fix');
    if (musts.length > 0 && options.anyway !== true) {
      return { ok: false, code: 'needs_anyway', message: 'The guide check still has open items. Apply anyway is your decision.', nextAction: 'Press Apply anyway, Dismiss, or Ask BotBoy to fix.', status: 409, change };
    }
    if ((change.sources.length > 0 || change.suspicious) && options.confirmFlagged !== true) {
      return { ok: false, code: 'confirm_required', message: change.sources.length ? `This text may come from ${sourceLabel(change.sources)}. Review the full diff, then confirm.` : 'The text of this change looks like instructions to an assistant. Review the full diff, then confirm.', nextAction: 'Press Review and apply again to confirm.', status: 409, change };
    }
    const gateIssue = await deterministicGates(change, plan);
    if (gateIssue) return { ok: false, ...gateIssue, status: 409, change };
    const rulesGuides = plan.rulesGuides?.length ? plan.rulesGuides : await rulesGuidesOfPlan(change);
    const notes = [...change.notes, ...change.unresolved.filter((item) => item.tier === 'should_fix')];
    const committed = await commit(plan, {
      actor: 'owner-via-botboy', kind: change.kind === 'create_set' ? 'create_set' : 'write', summary: summaryOf(plan, change.why), changeId: change.id,
      notes: notes.map(noteOf), overrode: musts.map((item) => `${item.tier}: ${clip(item.rule, 120)}`), sources: change.sources, rulesGuides,
    }, undefined, true);
    if (!committed.ok && committed.code === 'unrecorded') {
      const done = changes.update(change.id, { status: 'applied', statusReason: committed.message }) as KnowledgeChange;
      return { ok: false, code: 'history_unrecorded', message: committed.message, nextAction: committed.nextAction, status: 500, change: done };
    }
    if (!committed.ok) {
      const stale = committed.code === 'stale' || committed.code === 'rules_changed';
      if (stale) changes.update(change.id, { status: 'stale', statusReason: committed.message });
      return {
        ok: false, code: committed.code === 'io' ? 'internal_error' : committed.code === 'denied' ? 'invalid_path' : 'stale_base', message: committed.message,
        nextAction: stale ? 'Use Re-draft so BotBoy prepares it again from the current file and rules, or Dismiss.' : committed.nextAction,
        status: committed.code === 'io' ? 500 : 409, change: changes.get(change.id) ?? change,
      };
    }
    const done = changes.update(change.id, { status: 'applied', historyId: committed.historyId, notes, overrode: musts.map((item) => `${item.tier}: ${clip(item.rule, 120)}`) }) as KnowledgeChange;
    return { ok: true, change: done, historyId: committed.historyId, summary: plan.summary };
  }

  /**
   * The gates that never bend, the same ones the plan passed: set still writable, no generated file, the writable-type rule
   * (.md and .txt, and .json only when the governing guide declares writeTypes: json and the text parses), sizes, and a path
   * inside the folder. A file outside the plan's own set (the far side of a cross-set move) is held to .md and .txt.
   */
  async function deterministicGates(change: KnowledgeChange, plan: ChangePlan): Promise<{ code: string; message: string; nextAction: string } | null> {
    let setRel: string | null = null;
    let setGuide: ParsedGuide | null = null;
    if (change.kind === 'write' && plan.set !== ROOT_SET_ID) {
      const inspected = await library.inspect(plan.set);
      if (!('ok' in inspected) || inspected.ok !== true || !inspected.set) return { code: 'set_not_found', message: 'The set no longer exists.', nextAction: 'Dismiss this change.' };
      if (!inspected.set.writable) return { code: 'read_only_set', message: `${inspected.set.name} is read-only now.`, nextAction: 'Dismiss this change.' };
      setRel = relativeToRoot(inspected.root, inspected.set.dir);
      if (inspected.set.guidePath) {
        const bytes = await readIfExists(inspected.set.guidePath).catch(() => null);
        if (bytes) setGuide = parseGuide(bytes.toString('utf8'));
      }
      for (const item of plan.files) {
        if (!item.path.startsWith(`${setRel}/`)) continue;
        const rel = item.path.slice(setRel.length + 1);
        const reason = generatedFileReason(inspected.set, rel);
        if (reason && !isGuideName(rel)) return { code: 'generated_file', message: `${rel} is generated: ${reason}.`, nextAction: 'Dismiss this change.' };
      }
    }
    // A created set's files are governed by the guide the change itself creates.
    const newGuideText = change.kind === 'create_set' ? plan.files.find((item) => item.path === `${plan.set}/${GUIDE_FILE_NAME}`)?.after ?? null : null;
    const newGuide = newGuideText ? parseGuide(newGuideText) : null;
    for (const item of plan.files) {
      if (item.after !== null && Buffer.byteLength(item.after, 'utf8') > MAX_RESULT_BYTES) return { code: 'result_too_large', message: `${item.path} would be larger than 4 MB.`, nextAction: 'Dismiss this change.' };
      if (item.after !== null) {
        const governing = change.kind === 'create_set' ? (item.path.startsWith(`${plan.set}/`) ? newGuide : null) : setRel && item.path.startsWith(`${setRel}/`) ? setGuide : null;
        const issue = isGuideName(item.path)
          ? (path.extname(item.path).toLowerCase() === '.md' ? null : failure('unsupported_type', `${item.path} is not a writable type.`, 'Dismiss this change.'))
          : validateWritableType(item.path, governing, item.after);
        if (issue) return { code: issue.code, message: issue.message, nextAction: 'Dismiss this change.' };
      }
      if (item.path.split('/').some((part) => part === '..' || (part.startsWith('.') && part !== '.'))) return { code: 'invalid_path', message: 'A path in this change is not allowed.', nextAction: 'Dismiss this change.' };
    }
    return null;
  }

  /**
   * The guide whose rules a staged change was written under (the set's own, or the root's for a created set), with the
   * digest it had then. Apply refuses with `rules_changed` when a hand edit changed those rules since.
   */
  async function rulesGuidesOfPlan(change: KnowledgeChange): Promise<Array<{ path: string; digest: string }>> {
    if (!change.rulesSha256) return [];
    const inspected = await library.inspect(change.kind === 'create_set' ? ROOT_SET_ID : change.setName);
    if (!('ok' in inspected) || inspected.ok !== true) return [];
    const guidePath = inspected.set ? inspected.set.guidePath : inspected.rootGuidePath;
    return guidePath ? [{ path: relativeToRoot(inspected.root, guidePath), digest: change.rulesSha256 }] : [];
  }

  /**
   * What a Retry check writes back, written under the per-root lock the owner's Apply takes and only while the change is still the
   * one the check started from. An Apply, a Dismiss or a revision that landed during the model call wins: the check never turns an
   * applied change back into a card (P2 review R25).
   */
  function settleRecheck(started: KnowledgeChange, patch: ChangePatch): Promise<{ change: KnowledgeChange } | { refusal: ApplyResult }> {
    return library.withLock(async () => {
      const fresh = changes.get(started.id);
      if (!fresh) return { refusal: { ok: false, code: 'change_not_found', message: 'That change is unknown or has expired.', nextAction: 'Ask BotBoy to prepare it again.', status: 404 } as ApplyResult };
      if (fresh.status === 'applied' || fresh.status === 'dismissed' || fresh.status === 'expired') {
        return { refusal: { ok: false, code: 'change_closed', message: `That change became ${fresh.status} while it was being checked, so the check result was not saved.`, nextAction: 'Nothing to do.', status: 409, change: fresh } as ApplyResult };
      }
      if ((fresh.status !== 'held' && fresh.status !== 'staged') || fresh.candidateSha256 !== started.candidateSha256) {
        return { refusal: { ok: false, code: 'change_not_ready', message: 'That change was revised while it was being checked, so the check result was not saved.', nextAction: 'Open the card again; the new version has not been checked by this click.', status: 409, change: fresh } as ApplyResult };
      }
      return { change: changes.update(fresh.id, patch) as KnowledgeChange };
    });
  }

  async function recheck(changeId: string, options: { signal?: AbortSignal } = {}): Promise<ApplyResult> {
    const change = changes.get(changeId);
    if (!change) return { ok: false, code: 'change_not_found', message: 'That change is unknown or has expired.', nextAction: 'Ask BotBoy to prepare it again.', status: 404 };
    if (!['held', 'staged'].includes(change.status)) {
      return { ok: false, code: 'change_not_ready', message: `Only a held or waiting change can be checked again; this one is ${change.status}.`, nextAction: 'Nothing to do.', status: 409, change };
    }
    if (!change.plan) return { ok: false, code: 'change_not_ready', message: 'This change has nothing left to check.', nextAction: 'Dismiss it.', status: 409, change };
    if (change.kind === 'create_set') return recheckNewSet(change, options);
    if (change.kind !== 'write' || !change.file) {
      return { ok: false, code: 'change_not_ready', message: 'Only a held or waiting change of a file can be checked again.', nextAction: 'Nothing to do.', status: 409, change };
    }
    const resolved = await targetFor(change.setName);
    if ('ok' in resolved && resolved.ok === false) return { ok: false, code: resolved.code, message: resolved.message, nextAction: resolved.nextAction, status: 409, change };
    const { target, inspected } = resolved as { target: Target; inspected: InspectResult };
    const primary = change.plan.files.find((item) => item.path === relativeToRoot(inspected.root, path.join(target.dir, ...change.file!.split('/')))) ?? change.plan.files[0];
    const currentBytes = await readIfExists(path.join(inspected.root, ...primary.path.split('/'))).catch(() => null);
    if (hashText(currentBytes ? currentBytes.toString('utf8') : null) !== primary.before) {
      const settled = await settleRecheck(change, { status: 'stale', statusReason: 'The file changed after this was prepared.' });
      if ('refusal' in settled) return settled.refusal;
      return { ok: false, code: 'stale_base', message: 'The file changed after this was prepared.', nextAction: 'Use Re-draft so BotBoy prepares it again, or Dismiss.', status: 409, change: settled.change };
    }
    const before = currentBytes ? currentBytes.toString('utf8') : null;
    const outcome = await check.run({
      setId: target.setId, guideText: target.guideText, guide: target.guide as ParsedGuide, target: { file: change.file, purpose: (target.guide && rowFor(target.guide, change.file, namesOf(target))?.purpose) ?? '' },
      mode: change.plan.mode, before, after: primary.after, diff: diffLines(before ?? '', primary.after ?? ''), tied: isGuideName(change.file) ? [] : await readTied(target, change.file), guideEdit: isGuideName(change.file),
    }, { signal: options.signal });
    if (!outcome.ok) {
      const settled = await settleRecheck(change, { status: 'held', statusReason: outcome.message, check: { reason: outcome.reason, message: outcome.message, nextAction: outcome.nextAction } });
      if ('refusal' in settled) return settled.refusal;
      return { ok: false, code: 'held_check_unavailable', message: outcome.message, nextAction: outcome.nextAction, status: 409, change: settled.change };
    }
    // The held plan carried the server's guide refresh WITHOUT the model's summaries (the check had not run). Now that it has,
    // splice the table row and the TOC summary again from `summaryUpdate`, so O9's summaries are the model's, not a first line.
    let plan = change.plan;
    let diffText = change.diffText;
    if (outcome.summaryUpdate && REFRESHABLE_MODES.includes(plan.mode) && target.guide && target.guidePath && !isGuideName(change.file)) {
      const guideRel = relativeToRoot(inspected.root, target.guidePath);
      if (change.rulesSha256 && target.digest !== change.rulesSha256) {
        const settled = await settleRecheck(change, { status: 'stale', statusReason: 'The guide\'s rules were edited after this change was prepared.' });
        if ('refusal' in settled) return settled.refusal;
        return { ok: false, code: 'stale_base', message: 'The guide\'s rules were edited after this change was prepared.', nextAction: 'Use Re-draft so BotBoy prepares it again under the current rules, or Dismiss.', status: 409, change: settled.change };
      }
      const respliced: ChangePlan = { ...plan, files: plan.files.filter((item) => item.path !== guideRel) };
      const refreshFailure = withGuideRefresh(respliced, { file: change.file } as Parsed, target, inspected, { primaryBefore: before, primaryAfter: primary.after } as Built, outcome.summaryUpdate);
      if (refreshFailure) return { ok: false, code: refreshFailure.code, message: refreshFailure.message, nextAction: refreshFailure.nextAction, status: 409, change };
      plan = respliced;
      diffText = diffTextOf(plan, await loadBefores(plan, inspected.root));
    }
    const musts = outcome.items.filter((item) => item.tier === 'must_fix');
    const settled = await settleRecheck(change, {
      status: 'staged', statusReason: null, plan, diffText, items: outcome.items, unresolved: musts.length > 0 ? outcome.items.filter((item) => item.tier !== 'note') : [],
      notes: outcome.items.filter((item) => item.tier !== 'must_fix'), check: { coverage: outcome.coverage }, suspicious: change.suspicious || outcome.suspiciousDirective,
    });
    if ('refusal' in settled) return settled.refusal;
    return { ok: true, change: settled.change, historyId: '', summary: 'checked' };
  }

  /** Retry check on a held new set: the same check as at creation, over the stored guide text and the current root rules. */
  async function recheckNewSet(change: KnowledgeChange, options: { signal?: AbortSignal }): Promise<ApplyResult> {
    const plan = change.plan as ChangePlan;
    const inspected = await library.inspect(ROOT_SET_ID);
    if (!('ok' in inspected) || inspected.ok !== true) {
      const bad = inspected as { code: string; message: string; nextAction: string };
      return { ok: false, code: bad.code, message: bad.message, nextAction: bad.nextAction, status: 409, change };
    }
    const rootGuideBytes = inspected.rootGuidePath ? await readIfExists(inspected.rootGuidePath).catch(() => null) : null;
    const rootGuideText = rootGuideBytes ? rootGuideBytes.toString('utf8') : ROOT_GUIDE_SEED;
    const rootGuide = parseGuide(rootGuideText);
    if (change.rulesSha256 && rulesDigest(rootGuide) !== change.rulesSha256) {
      const settled = await settleRecheck(change, { status: 'stale', statusReason: 'The root guide\'s rules were edited after this set was drafted.' });
      if ('refusal' in settled) return settled.refusal;
      return { ok: false, code: 'stale_base', message: 'The root guide\'s rules were edited after this set was drafted.', nextAction: 'Ask BotBoy to create the set again, or Dismiss.', status: 409, change: settled.change };
    }
    const guideItem = plan.files.find((item) => item.path === `${plan.set}/${GUIDE_FILE_NAME}`);
    if (!guideItem || guideItem.after === null) return { ok: false, code: 'change_not_ready', message: 'This change has no drafted guide to check.', nextAction: 'Dismiss it and ask BotBoy to create the set again.', status: 409, change };
    const outcome = await checkNewSetGuide(rootGuideText, rootGuide, plan.set, guideItem.after, options.signal);
    if (!outcome.ok) {
      const settled = await settleRecheck(change, { status: 'held', statusReason: outcome.message, check: { reason: outcome.reason, message: outcome.message, nextAction: outcome.nextAction } });
      if ('refusal' in settled) return settled.refusal;
      return { ok: false, code: 'held_check_unavailable', message: outcome.message, nextAction: outcome.nextAction, status: 409, change: settled.change };
    }
    const musts = outcome.items.filter((item) => item.tier === 'must_fix');
    const settled = await settleRecheck(change, {
      status: 'staged', statusReason: musts.length > 0 ? 'The guide check still found a breach.' : null, items: outcome.items, unresolved: musts.length > 0 ? outcome.items.filter((item) => item.tier !== 'note') : [],
      notes: outcome.items.filter((item) => item.tier !== 'must_fix'), check: { coverage: outcome.coverage }, suspicious: change.suspicious || outcome.suspiciousDirective,
    });
    if ('refusal' in settled) return settled.refusal;
    return { ok: true, change: settled.change, historyId: '', summary: 'checked' };
  }

  async function rulesPayloadFor(setId: string, file: string): Promise<{ fence: string; trailer: string; delivery: GuideDelivery; rulesSha256: string } | Failure> {
    const resolved = await targetFor(setId);
    if ('ok' in resolved && resolved.ok === false) return resolved;
    const { target } = resolved as { target: Target };
    if (!target.guide) return failure('guide_required', 'No usable guide.', 'Create one first.');
    const kind = targetKindFor(target, file);
    const payload = buildRulesPayload({ setId: target.setId, kind: target.kind, guide: target.guide, guideText: target.guideText, target: { file, kind }, names: namesOf(target) });
    if (payload.tooLong) return failure('rules_too_long', 'The rules are too long to deliver.', 'The owner shortens the guide.');
    return { fence: payload.fence, trailer: payload.trailer, delivery: payload.delivery, rulesSha256: payload.delivery.rulesSha256 };
  }

  return {
    write,
    createSet,
    apply: applyStaged,
    dismiss(changeId) {
      const change = changes.get(changeId);
      if (!change || ['applied', 'dismissed', 'expired'].includes(change.status)) return change;
      return changes.update(change.id, { status: 'dismissed', statusReason: 'Dismissed by the owner.' });
    },
    recheck,
    async undo() {
      const result = await library.withLock(async () => {
        const outcome = await history.undo();
        if (outcome.ok) {
          // The files Undo took away (a created file) may leave a folder empty: a set created and undone leaves no shell behind.
          const inspected = await library.inspect(ROOT_SET_ID).catch(() => null);
          if (inspected && 'ok' in inspected && inspected.ok === true) {
            await pruneEmptied(inspected.root, inspected.rootGuidePath ?? null, outcome.entry.files.filter((file) => file.after === null).map((file) => file.path));
          }
        }
        return outcome;
      });
      if (result.ok) { library.invalidate(); library.bump(); }
      return result;
    },
    rulesPayloadFor,
    async writeBlockFor(setId) {
      const resolved = await targetFor(setId);
      if ('ok' in resolved && resolved.ok === false) return null;
      const { target } = resolved as { target: Target };
      if (!target.guide || target.isRoot) return null;
      const block = buildWriteInstructionsBlock({ setId: target.setId, kind: target.kind, description: target.set?.description ?? '', guide: target.guide });
      return { text: block.text, delivery: block.delivery };
    },
  };
}
