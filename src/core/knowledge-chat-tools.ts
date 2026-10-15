/**
 * The Knowledge library in chat (knowledge-library.md K9, K18): two read tools and three write tools, offered only once the
 * owner has created the library (the write tools only on a turn with a write intent).
 *
 *   knowledge_list {set?}                       → the sets and categories, or one set's files with purposes
 *   knowledge_load {set, file, section?, lines?} → ONE file, whole; a file too big for this turn returns an outline
 *   knowledge_propose / knowledge_write / knowledge_create_set → the composite writer (knowledge-write.ts): stage-only, the
 *     owner's exact request, and a whole new set; every one is a structured answer that names the next action
 *
 * Practical agent framework, Capabilities: each tool traces to an outcome (O3: SQL, ETL and product work check the library
 * first, also while the sql-context connection is down). Reads are in the job mandate's closed allowlist on purpose
 * (a continuation may read the library); nothing here writes. Every result is a structured object that names the next
 * action; a file arrives fenced as untrusted data and cannot grant authority.
 */
import path from 'path';
import type { ToolCall } from './llm-client.js';
import { currentLlmModelOperation } from './llm-model-operation.js';
import { sanitizeSetName, secretFree } from './knowledge-guide.js';
import type { KnowledgeLibrary, LoadFailure, LoadLimits } from './knowledge-library.js';
import type { KnowledgeHistory } from './knowledge-history.js';
import { recordDelivery, type KnowledgeWriter } from './knowledge-write.js';
import { writeProtectedRootsInEffect } from './protected-local-resources.js';
import type { ToolExecutionContext, ToolExecutor, ToolResult } from './tool-executor.js';

/** Offered once the library exists: two reads and the stage-only proposal (always a card; a continuation may use it). */
export const KNOWLEDGE_CHAT_TOOL_NAMES = ['knowledge_list', 'knowledge_load', 'knowledge_propose'] as const;
/** Offered only on turns whose routing saw a write intent from the owner (amendment P2-6); live owner turns only. */
export const KNOWLEDGE_WRITE_TOOL_NAMES = ['knowledge_write', 'knowledge_create_set'] as const;
export type KnowledgeChatToolName = (typeof KNOWLEDGE_CHAT_TOOL_NAMES)[number] | (typeof KNOWLEDGE_WRITE_TOOL_NAMES)[number];

/** One chain per tool-execution context (one request): the loads of an assistant message are measured one after the other. */
const loadChains = new WeakMap<object, Promise<unknown>>();

const MAX_SETS_LISTED = 60;
const MAX_FILES_LISTED = 120;
const MAX_SUMMARY_BULLETS = 4;
/** A set's display name for the model: the safe alphabet the standing line uses (names are outside any fence), or its id. */
const safeName = (set: { id: string; name: string }) => sanitizeSetName(set.name) || set.id;
const clip = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`);

function reply(call: ToolCall, content: unknown, isError = false): ToolResult {
  return { toolCallId: call.id, content: typeof content === 'string' ? content : JSON.stringify(content), isError };
}

function failed(call: ToolCall, code: string, message: string, nextAction: string, extra: Record<string, unknown> = {}): ToolResult {
  return reply(call, { ok: false, tool: call.function.name, status: 'failed', code, message, effect: 'none', nextAction, ...extra }, true);
}

function fromLoadFailure(call: ToolCall, failure: LoadFailure): ToolResult {
  return failed(call, failure.code, failure.message, failure.nextAction, failure.details ?? {});
}

/** What the next load can use, read from the turn: the model's budget and window, and the prompt's remaining room. */
function limitsFor(context?: ToolExecutionContext): LoadLimits {
  const operation = currentLlmModelOperation();
  const budget = operation?.client.getContextBudgetTokens?.();
  return {
    ...(typeof budget === 'number' && budget > 0 ? { contextBudgetTokens: budget } : {}),
    ...(operation?.capabilities.contextWindow ? { contextWindowTokens: operation.capabilities.contextWindow } : {}),
    ...(typeof context?.promptHeadroomTokens === 'number' ? { promptHeadroomTokens: context.promptHeadroomTokens } : {}),
  };
}

/**
 * The hint appended to a failed `run_command` that tried to change the library: the sandbox denies it with a bare
 * "Operation not permitted", which tells the model nothing. Null unless the failure and the command both point at the
 * library's folder.
 */
export function knowledgeFolderWriteTip(stderr: string, command: string): string | null {
  if (!/operation not permitted/i.test(stderr)) return null;
  for (const root of writeProtectedRootsInEffect()) {
    const name = path.basename(root);
    if (command.includes(root) || (name.length >= 3 && command.includes(name))) {
      return 'The knowledge folder is read-only from commands. Change it with knowledge_write (only when the owner asked for exactly this edit) or knowledge_propose (the owner approves a card); the owner can also use Finder or an editor.';
    }
  }
  return null;
}

/** One log line per refusal or applied change: codes, ids and hash prefixes, never content (design Q4). */
function logOutcome(name: string, args: Record<string, unknown>, result: { ok: boolean; status?: string; code?: string; changeId?: string; historyId?: string }): void {
  const target = `${String(args.set ?? args.name ?? '-').slice(0, 80)}/${String(args.file ?? '-').slice(0, 80)}`;
  if (!result.ok) console.warn(`[Knowledge] ${result.code ?? 'failed'} ${target} (${name})`);
  else if (result.status === 'applied') console.info(`[Knowledge] applied ${target} (${name}) change ${result.changeId ?? '-'} history ${String(result.historyId ?? '-').slice(0, 14)}`);
  else console.info(`[Knowledge] staged ${target} (${name}) change ${result.changeId ?? '-'}`);
}

export function withKnowledgeChatTools(base: ToolExecutor, deps: { library: KnowledgeLibrary; writer?: KnowledgeWriter | null; history?: KnowledgeHistory | null }): ToolExecutor {
  const { library } = deps;
  // A list or a read is where an edit made outside BotBoy (Finder, an editor, a command) is noticed and recorded so the log and
  // Undo stay true. It runs beside the read, never in front of it: the first look hashes the folder, and the debounce keeps the
  // rest cheap. History skips a look while one of its own writes is in flight.
  const noticeOutsideEdits = (): void => { if (deps.history) void deps.history.reconcile().catch(() => undefined); };
  return {
    ...base,
    async executeTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
      const name = call.function.name;
      const isWrite = name === 'knowledge_propose' || name === 'knowledge_write' || name === 'knowledge_create_set';
      if (name !== 'knowledge_list' && name !== 'knowledge_load' && !isWrite) return base.executeTool(call, context);
      let args: Record<string, unknown>;
      try {
        const parsed = JSON.parse(call.function.arguments || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        args = parsed as Record<string, unknown>;
      } catch {
        return failed(call, 'invalid_arguments', 'Arguments must be one JSON object.', 'Fix the arguments, then call once more.');
      }

      if (isWrite) {
        if (!deps.writer) return failed(call, 'not_available', 'Writing to the Knowledge library is not available in this run.', 'Tell the owner; they can change the files in Finder or an editor.');
        const result = name === 'knowledge_create_set'
          ? await deps.writer.createSet(args, context)
          : await deps.writer.write(args, context, name);
        logOutcome(name, args, result);
        return reply(call, result, !result.ok);
      }

      noticeOutsideEdits();
      if (name === 'knowledge_list') {
        const wanted = args.set;
        if (wanted !== undefined && (typeof wanted !== 'string' || wanted.length > 120)) {
          return failed(call, 'invalid_arguments', 'set must be a set id (a string of at most 120 characters).', 'Call knowledge_list with no argument to see the set ids.');
        }
        if (typeof wanted === 'string' && wanted.trim()) {
          const detail = await library.getSet(wanted);
          if ('code' in detail) return fromLoadFailure(call, detail);
          // Purposes and summaries reach the model without a load, so a line with a secret format shows the file by name only.
          const files = detail.files.slice(0, MAX_FILES_LISTED).map((file) => ({
            name: file.name,
            bytes: file.bytes,
            purpose: clip(secretFree(file.purpose), 200),
            ...(file.summary.length ? { summary: file.summary.slice(0, MAX_SUMMARY_BULLETS).map((bullet) => clip(secretFree(bullet), 160)).filter(Boolean) } : {}),
            ...(file.status === 'not_downloaded' ? { status: 'not_downloaded' } : {}),
          }));
          return reply(call, {
            ok: true,
            set: { id: detail.id, name: safeName(detail), kind: detail.kind, description: clip(secretFree(detail.description), 240), guide: detail.hasGuide ? 'yes' : 'no' },
            files,
            ...(detail.files.length > files.length ? { moreFiles: detail.files.length - files.length } : {}),
            ...(detail.conflictOrder ? { conflictOrder: detail.conflictOrder } : {}),
            ...(detail.missingRows.length ? { listedInGuideButMissing: detail.missingRows.slice(0, 10) } : {}),
            ...(detail.issues.length ? { issues: detail.issues.slice(0, 5).map((issue) => clip(issue.message, 200)) } : {}),
            note: detail.hasGuide ? 'Load one file whole with knowledge_load when the task needs it. If you learn something worth keeping, propose it together with the rest at the end of the task (knowledge_propose).' : 'This set has no guide yet; its files are still readable with knowledge_load.',
          });
        }
        const listing = await library.listSets();
        if ('code' in listing) return fromLoadFailure(call, listing);
        return reply(call, {
          ok: true,
          sets: listing.sets.slice(0, MAX_SETS_LISTED).map((set) => ({
            id: set.id, name: safeName(set), kind: set.kind, description: clip(secretFree(set.description), 160), files: set.fileCount, guide: set.hasGuide ? 'yes' : 'no',
          })),
          ...(listing.sets.length > MAX_SETS_LISTED ? { moreSets: listing.sets.length - MAX_SETS_LISTED } : {}),
          categories: listing.categories.map((category) => ({ folder: category.folder, holds: clip(category.holds, 120) })),
          ...(listing.looseCount ? { looseFiles: listing.looseCount } : {}),
          note: 'Call knowledge_list with set=<id> for a set\'s files, then knowledge_load one file whole.',
        });
      }

      const setId = args.set;
      const file = args.file;
      if (typeof setId !== 'string' || !setId.trim() || setId.length > 120 || typeof file !== 'string' || !file.trim()) {
        return failed(call, 'invalid_arguments', 'set and file are required strings.', 'Call knowledge_list to get a set id and a file name, then call knowledge_load once.');
      }
      if (args.section !== undefined && (typeof args.section !== 'string' || args.section.length > 200)) {
        return failed(call, 'invalid_arguments', 'section must be an exact heading (a string of at most 200 characters).', 'Fix section, or use lines.');
      }
      if (args.lines !== undefined && !(Array.isArray(args.lines) && args.lines.length === 2 && args.lines.every((value) => Number.isInteger(value)))) {
        return failed(call, 'invalid_range', 'lines must be two whole numbers [from, to].', 'Call again with lines like [1, 120], or use section.');
      }
      const runLoad = async (): Promise<ToolResult> => {
        const loaded = await library.load({
          set: setId,
          file,
          ...(typeof args.section === 'string' ? { section: args.section } : {}),
          ...(Array.isArray(args.lines) ? { lines: args.lines as [number, number] } : {}),
        }, limitsFor(context));
        if (!loaded.ok) return fromLoadFailure(call, loaded);
        // What this load took is gone from the prompt's remaining room, so the next load in the same assistant message
        // is measured against what is left (P1 review D5). A refused load takes nothing.
        if (typeof context?.promptHeadroomTokens === 'number') {
          context.promptHeadroomTokens = Math.max(0, context.promptHeadroomTokens - loaded.receipt.estimatedTokens);
        }
        if (context) {
          if (path.basename(loaded.file).toLowerCase() === 'guide.md') {
            // A whole, unclipped GUIDE.md is a whole-guide delivery: its rules digest is in the header and covers every target.
            const digest = /rulesSha256 ([a-f0-9]{64})/.exec(loaded.text)?.[1];
            if (digest && !loaded.receipt.partial) recordDelivery(context, loaded.set, { rulesSha256: digest, full: true, whole: true, files: [] });
          } else {
            // A library file read in this turn counts as a possible source for a GUIDE edit (not for a content edit), P2-4.
            context.knowledgeNonGuideLoaded = true;
          }
        }
        return reply(call, [
          loaded.text,
          `receipt: ${JSON.stringify(loaded.receipt)}`,
          ...(loaded.tellOwner ? [`tellOwner: ${loaded.tellOwner}`] : []),
        ].join('\n'));
      };
      if (!context) return runLoad();
      // Loads of one assistant message run one after the other even when the chat loop dispatches them together, so the
      // second one always sees what the first one took.
      const previous = loadChains.get(context) ?? Promise.resolve();
      const next = previous.then(runLoad, runLoad);
      loadChains.set(context, next.catch(() => undefined));
      return next;
    },
  };
}
