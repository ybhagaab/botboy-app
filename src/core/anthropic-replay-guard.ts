/**
 * Thinking replay guard (design v3 D3 item 5, banner item 3): the only module
 * that holds Anthropic conversation state.
 *
 * Some models check, when thinking blocks are replayed, that everything BEFORE
 * them (`system`, `tools` and every earlier message) is byte-identical to the
 * request that produced them, and answer a 400 otherwise (S22). BotBoy edits
 * history after the fact in four places: the pre-flight trim of older tool
 * calls and results, image supersede and eviction, the image-free payload
 * recovery, and withheld tools. The guard therefore remembers, per thinking
 * block, a hash of the exact prefix the block was produced against, and before
 * every send drops the thinking of any assistant message whose prefix changed.
 *
 * Rules that never bend:
 *   - Whole runs only. All thinking blocks of one assistant message share one
 *     recorded prefix, so they are kept or dropped together; the guard never
 *     leaves a partial run (S3/S9: a partial drop of the latest message is a 400).
 *   - A drop leaves both the message and the running hash, so it cascades to
 *     every later run whose recorded prefix included it, while a run produced
 *     AFTER the drop (recorded against the post-drop body) is kept.
 *   - Hashes only: ids are SHA-256 of a signature or of a redacted blob; the
 *     ledger never holds reasoning text.
 *   - It is keyed on the MODEL (`enforce` comes from the profile's `prefixCheck`),
 *     never on account age. Where it does not enforce, history is replayed as is
 *     (a drop there would only cost reasoning), except blocks the API rejected
 *     earlier (the strip-all recovery applies to any model).
 *   - It is stricter than the API (kept blocks' ids are part of the hash, though
 *     earlier thinking is not in the API's prefix), never looser.
 */
import { createHash } from 'node:crypto';
import {
  canonicalJson,
  type AnthropicBlock,
  type AnthropicMessage,
  type AnthropicTool,
  type ToolsMemory,
} from './anthropic-messages.js';

/**
 * What to do with an assistant message whose replayed `tool_use` input differs from the response's own.
 * 'keep': its thinking replays as returned (S22 defines the checked prefix as the EARLIER messages).
 * 'drop_run': the whole run of that message goes. Probe P7 decides which one is right; a wrong default
 * costs one recovered request (item 5), where dropping part of the latest message could cost a failed turn.
 */
export const SAME_MESSAGE_EDIT: 'keep' | 'drop_run' = 'keep';
/**
 * Optional first step of the typed recovery: retry once with the documented `drop_block` control before
 * stripping everything. Off by default: it needs the beta header, which production never sends otherwise.
 */
export const RECOVERY_DROP_BLOCK_FIRST = false;
export const LEDGER_MAX_ENTRIES = 512;
export const STRIPPED_MAX_ENTRIES = 512;
export const TOOLS_MEMORY_MAX_ENTRIES = 8;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

type ThinkingBlock = Extract<AnthropicBlock, { type: 'thinking' | 'redacted_thinking' }>;
const isThinkingBlock = (block: AnthropicBlock): block is ThinkingBlock => block.type === 'thinking' || block.type === 'redacted_thinking';

/** `t:` + sha256(signature) for a thinking block, `r:` + sha256(data) for a redacted one (it has no signature). */
export function thinkingBlockId(block: AnthropicBlock): string | undefined {
  if (block.type === 'thinking') return `t:${sha256(block.signature)}`;
  if (block.type === 'redacted_thinking') return `r:${sha256(block.data)}`;
  return undefined;
}

export function messageHasThinking(message: AnthropicMessage): boolean {
  return message.role === 'assistant' && message.content.some(isThinkingBlock);
}

export function bodyHasThinking(messages: readonly AnthropicMessage[]): boolean {
  return messages.some(messageHasThinking);
}

/** A message as the running hash sees it: each kept thinking block is its id, `cache_control` is outside the prefix. */
function hashableMessage(message: AnthropicMessage): unknown {
  return {
    role: message.role,
    content: message.content.map(block => {
      const id = thinkingBlockId(block);
      if (id) return { bid: id };
      const { cache_control: _ignored, ...rest } = block as AnthropicBlock & { cache_control?: unknown };
      return rest;
    }),
  };
}

export type GuardDropCause = 'system' | 'tools' | 'messages' | 'stripped' | 'edited';

export interface GuardDrop {
  /** Index of the assistant message, in the body that was evaluated. */
  readonly messageIndex: number;
  /** How many thinking blocks (the whole run) left that message. */
  readonly blocks: number;
  readonly cause: GuardDropCause;
}

export interface GuardInput {
  system?: string;
  tools?: readonly AnthropicTool[];
  /** The messages exactly as they would be sent (tool_use inputs already substituted), before any drop. */
  messages: readonly AnthropicMessage[];
  /** Assistant message indexes flagged `edited` by `convertHistory`. */
  edited?: readonly number[];
  /** `deriveProfile(profile).prefixCheck`: false replays history as is and records nothing. */
  enforce: boolean;
}

export interface GuardEvaluation {
  /** The messages to send: the input array itself when nothing was dropped. */
  readonly messages: AnthropicMessage[];
  readonly drops: readonly GuardDrop[];
  /** Digest of the sent body; the prefix every thinking block of the NEXT response is recorded against. */
  readonly prefix: string;
  readonly systemDigest: string;
  readonly toolsDigest: string;
  readonly enforced: boolean;
  /** Assistant messages that hold thinking and were edited in place but kept (a log line only under 'keep'). */
  readonly editedKept: readonly number[];
}

interface LedgerEntry { prefix: string; systemDigest: string; toolsDigest: string }

export interface ReplayGuardOptions {
  sameMessageEdit?: 'keep' | 'drop_run';
  recoveryDropBlockFirst?: boolean;
}

export interface ReplayGuard extends ToolsMemory {
  /** One pass in wire order before every send; drops whole thinking runs whose prefix changed. */
  evaluate(input: GuardInput): GuardEvaluation;
  /** After a response completes: remember the prefix each of its thinking blocks was produced against. */
  record(evaluation: GuardEvaluation, response: readonly AnthropicBlock[]): void;
  /**
   * After one of the two documented thinking-block 400s: forget every thinking block in `messages` for the rest
   * of the process ("once you remove a block, leave it out", S22). Returns how many ids were added.
   */
  stripAll(messages: readonly AnthropicMessage[]): number;
  readonly sameMessageEdit: 'keep' | 'drop_run';
  readonly recoveryDropBlockFirst: boolean;
  /** Test and probe seam. */
  readonly sizes: { ledger: number; stripped: number; toolSets: number };
}

function boundedMapSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

export function createReplayGuard(options: ReplayGuardOptions = {}): ReplayGuard {
  const sameMessageEdit = options.sameMessageEdit ?? SAME_MESSAGE_EDIT;
  const recoveryDropBlockFirst = options.recoveryDropBlockFirst ?? RECOVERY_DROP_BLOCK_FIRST;
  const ledger = new Map<string, LedgerEntry>();
  const stripped = new Set<string>();
  const toolSets = new Map<string, AnthropicTool[]>();
  // The same tools array object (the withheld path re-sends one) is hashed once.
  const toolsDigests = new WeakMap<object, string>();

  const toolsDigest = (tools: readonly AnthropicTool[] | undefined): string => {
    if (!tools) return sha256('null');
    const cached = toolsDigests.get(tools);
    if (cached) return cached;
    const digest = sha256(canonicalJson(tools));
    toolsDigests.set(tools, digest);
    return digest;
  };

  const evaluate = (input: GuardInput): GuardEvaluation => {
    const systemDigest = sha256(canonicalJson(input.system ?? null));
    const digestOfTools = toolsDigest(input.tools);
    if (!input.enforce) {
      // Replayed as is and nothing recorded, except blocks the API itself rejected earlier: "once you remove a
      // block, leave it out" holds for any model that answered one of the two documented 400s.
      const drops: GuardDrop[] = [];
      const messages = stripped.size === 0 ? (input.messages as AnthropicMessage[]) : input.messages.map((message, index) => {
        if (!messageHasThinking(message) || !message.content.some(block => stripped.has(thinkingBlockId(block) ?? ''))) return message;
        const kept = message.content.filter(block => !isThinkingBlock(block));
        drops.push({ messageIndex: index, blocks: message.content.length - kept.length, cause: 'stripped' });
        return { role: message.role, content: kept };
      });
      return { messages: drops.length ? messages : (input.messages as AnthropicMessage[]), drops, prefix: '', systemDigest, toolsDigest: digestOfTools, enforced: false, editedKept: [] };
    }
    const edited = new Set(input.edited ?? []);
    const hash = createHash('sha256');
    hash.update(`S:${systemDigest}\nT:${digestOfTools}\n`);
    const output: AnthropicMessage[] = [];
    const drops: GuardDrop[] = [];
    const editedKept: number[] = [];
    let changed = false;

    input.messages.forEach((message, index) => {
      let current = message;
      if (messageHasThinking(message)) {
        const ids = message.content.map(thinkingBlockId).filter((id): id is string => id !== undefined);
        // The prefix this message must still sit on: everything before it, as it will be sent.
        const before = hash.copy().digest('hex');
        let cause: GuardDropCause | undefined;
        if (ids.some(id => stripped.has(id))) {
          cause = 'stripped';
        } else {
          const mismatched = ids.map(id => ledger.get(id)).find(entry => entry !== undefined && entry.prefix !== before);
          if (mismatched) cause = mismatched.systemDigest !== systemDigest ? 'system' : mismatched.toolsDigest !== digestOfTools ? 'tools' : 'messages';
          else if (edited.has(index) && sameMessageEdit === 'drop_run') cause = 'edited';
        }
        if (cause) {
          const kept = message.content.filter(block => !isThinkingBlock(block));
          drops.push({ messageIndex: index, blocks: message.content.length - kept.length, cause });
          current = { role: message.role, content: kept };
          changed = true;
        } else {
          // Unknown ids (evicted or foreign) pass through; a message with some known ids follows those.
          for (const id of ids) {
            const entry = ledger.get(id);
            if (entry) boundedMapSet(ledger, id, entry, LEDGER_MAX_ENTRIES);
          }
          if (edited.has(index)) editedKept.push(index);
        }
      }
      output.push(current);
      hash.update(`M:${canonicalJson(hashableMessage(current))}\n`);
    });

    return {
      messages: changed ? output : (input.messages as AnthropicMessage[]),
      drops,
      prefix: hash.digest('hex'),
      systemDigest,
      toolsDigest: digestOfTools,
      enforced: true,
      editedKept,
    };
  };

  return {
    sameMessageEdit,
    recoveryDropBlockFirst,
    evaluate,

    record(evaluation, response) {
      if (!evaluation.enforced) return;
      for (const block of response) {
        const id = thinkingBlockId(block);
        if (id) {
          boundedMapSet(ledger, id, { prefix: evaluation.prefix, systemDigest: evaluation.systemDigest, toolsDigest: evaluation.toolsDigest }, LEDGER_MAX_ENTRIES);
        }
      }
    },

    stripAll(messages) {
      let added = 0;
      for (const message of messages) {
        for (const block of message.content) {
          const id = thinkingBlockId(block);
          if (!id) continue;
          if (!stripped.has(id)) added += 1;
          stripped.delete(id);
          stripped.add(id);
          ledger.delete(id);
        }
      }
      while (stripped.size > STRIPPED_MAX_ENTRIES) stripped.delete(stripped.values().next().value as string);
      return added;
    },

    // ── Withheld-tools memory (L12): an 8-entry LRU keyed by the sorted tool-name set ──

    remember(tools) {
      const key = tools.map(tool => tool.name).sort().join('\u0000');
      boundedMapSet(toolSets, key, [...tools], TOOLS_MEMORY_MAX_ENTRIES);
    },

    resolveWithheld(names) {
      const needed = [...new Set(names)];
      // The most recent entry that defines every tool name in the history.
      for (const tools of [...toolSets.values()].reverse()) {
        const have = new Set(tools.map(tool => tool.name));
        if (needed.every(name => have.has(name))) return tools;
      }
      // Fallback: stub definitions for every name seen. This changes `tools`, which the guard then sees as a
      // changed prefix, so earlier thinking is dropped with it.
      return needed.sort().map(name => ({
        name,
        description: '(Unavailable in this step.)',
        input_schema: { type: 'object', properties: {} },
      }));
    },

    get sizes() {
      return { ledger: ledger.size, stripped: stripped.size, toolSets: toolSets.size };
    },
  };
}
