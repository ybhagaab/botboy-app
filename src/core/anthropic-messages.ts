/**
 * Anthropic Messages mapping (design v3 D2, D3, D5, D6, D7, D8): the pure half
 * of the Claude transport. Everything here is a function of its arguments, so
 * the whole request shape and the whole stream reduction are tested without a
 * network. `anthropic-client.ts` owns I/O, retries, health and usage rows;
 * `anthropic-replay-guard.ts` owns the only conversation state.
 *
 * Framework effects (practical-agent-framework):
 *   - Runtime context: one shaped request body per call (system, tools, history,
 *     thinking, effort, `max_tokens`, optional response format and cache marker).
 *   - Capabilities: request validity lives HERE (history rules, thinking and
 *     effort forms from the model's own profile, tool schemas), so one place
 *     changes when the API drifts.
 *   - Never on the wire: `temperature`, `top_p`, `top_k`, assistant prefill, a
 *     `tool_choice` other than `none`.
 */
import type {
  ChatCompletionRequest,
  LlmMessage,
  LlmResponseFormat,
  LlmUsage,
  ProviderRequestSize,
  StreamChunk,
  ToolCall,
  ToolDefinition,
} from './llm-client.js';
import { redactProviderSecrets } from './llm-client.js';
import type { ParsedProviderUsage } from './llm-usage.js';
import { emptyProviderUsage } from './llm-usage.js';
import { AnthropicApiError, classifyAnthropicHttpError, statusForAnthropicErrorType } from './anthropic-errors.js';
import {
  deriveProfile,
  shapeThinking,
  type AnthropicModelProfile,
  type AnthropicThinkingParam,
  type AnthropicThinkingShape,
} from './anthropic-models.js';
import {
  adaptSchemaForAnthropic,
  normalizeJsonModeText,
  toAnthropicInputSchema,
  withJsonModeInstruction,
  withSchemaPromptInstruction,
} from './anthropic-schema.js';
import type { LlmThinkingLevel } from './llm-model-catalog.js';

// ── Wire types ──

export interface AnthropicTextBlock { type: 'text'; text: string }
export interface AnthropicImageBlock { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
export interface AnthropicThinkingBlock { type: 'thinking'; thinking: string; signature: string }
export interface AnthropicRedactedThinkingBlock { type: 'redacted_thinking'; data: string }
export interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
export interface AnthropicToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string; is_error?: true }
export type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage { role: 'user' | 'assistant'; content: AnthropicBlock[] }

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  eager_input_streaming?: true;
}

export interface AnthropicOutputConfig {
  effort?: 'low' | 'medium' | 'high' | 'max';
  format?: { type: 'json_schema'; schema: Record<string, unknown> };
}

/** `thinking`, plus the documented block-binding control used only by the recovery retry and the probe (S22). */
export type AnthropicWireThinking = AnthropicThinkingParam & {
  block_binding?: { prefix_mismatch_behavior: 'drop_block' | 'error' };
};

export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  stream: boolean;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: { type: 'none' };
  thinking?: AnthropicWireThinking;
  output_config?: AnthropicOutputConfig;
  cache_control?: { type: 'ephemeral' };
}

/** A request BotBoy cannot make valid; raised before any network call. */
export type AnthropicHistoryErrorKind =
  | 'history_ends_with_assistant'
  | 'history_empty'
  | 'unsupported_image_type'
  | 'too_many_images'
  | 'image_too_large';

export class AnthropicHistoryError extends Error {
  readonly code = 'ANTHROPIC_HISTORY';
  constructor(readonly kind: AnthropicHistoryErrorKind, message: string, readonly nextAction: string) {
    super(message);
    this.name = 'AnthropicHistoryError';
  }
}

export function isAnthropicHistoryError(error: unknown): error is AnthropicHistoryError {
  return error instanceof AnthropicHistoryError || (error as { code?: unknown } | null)?.code === 'ANTHROPIC_HISTORY';
}

// ── Small helpers ──

const OMITTED_LINE = '(Earlier messages omitted.)';
const EMPTY_RESULT_TEXT = '(empty result)';
const STUB_RESULT_TEXT = 'Tool result unavailable: the earlier step was interrupted before it returned.';
const MAX_IMAGES_ON_200K_WINDOW = 100;
const MAX_IMAGE_BASE64_CHARS = 10_000_000;
const IMAGE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
});

/** The two tools whose arguments carry whole documents; their parameters stream eagerly (D6). */
export const EAGER_INPUT_TOOLS: ReadonlySet<string> = new Set(['write_file', 'save_product_document']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** JSON with every object's keys sorted: the one serialization the guard hashes and the edit check compares. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** `tool_use.id` must match `^[a-zA-Z0-9_-]+$`; ids from other providers are mapped the same way on both sides. */
export function sanitizeToolId(id: unknown): string {
  const text = typeof id === 'string' ? id : '';
  const clean = text.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return clean || 'toolu_unknown';
}

function parseToolArguments(raw: unknown): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { ok: true, value: {} };
  if (isPlainObject(raw)) return { ok: true, value: raw };
  if (typeof raw !== 'string') return { ok: false };
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? { ok: true, value: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** `data:image/png;base64,…` → an Anthropic image block, or a typed error naming the fix. */
export function imageBlockFromDataUrl(dataUrl: string): AnthropicImageBlock {
  const match = /^data:([A-Za-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl));
  const mediaType = match ? IMAGE_TYPES[match[1].toLowerCase()] : undefined;
  if (!match || !mediaType) {
    throw new AnthropicHistoryError(
      'unsupported_image_type',
      'Claude accepts JPEG, PNG, GIF and WebP images only.',
      'Attach the image as a JPEG, PNG, GIF or WebP file, then send it again.',
    );
  }
  const data = match[2].replace(/\s+/g, '');
  if (data.length > MAX_IMAGE_BASE64_CHARS) {
    throw new AnthropicHistoryError(
      'image_too_large',
      'An attached image is larger than Claude accepts (10 MB).',
      'Attach a smaller or lower-resolution copy of the image, then send it again.',
    );
  }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

// ── Tools (D3) ──

/** `ToolDefinition` → the Messages tool shape. Non-strict; a pure function of the definition, so `tools` stays byte-stable across requests. */
export function toAnthropicTools(tools: readonly ToolDefinition[]): AnthropicTool[] {
  return tools.map(tool => ({
    name: tool.function.name,
    description: tool.function.description ?? '',
    input_schema: toAnthropicInputSchema(tool.function.parameters),
    ...(EAGER_INPUT_TOOLS.has(tool.function.name) ? { eager_input_streaming: true as const } : {}),
  }));
}

/** Where the withheld-tools rule keeps the last real tool arrays (implemented by the replay guard, L12). */
export interface ToolsMemory {
  remember(tools: readonly AnthropicTool[]): void;
  /** The most recent remembered array that defines every name in `names`, else stub definitions for each name. */
  resolveWithheld(names: readonly string[]): AnthropicTool[];
}

export interface WireTools {
  tools?: AnthropicTool[];
  /** true when the caller sent no tools but the history holds tool blocks: the real array is re-sent with `tool_choice: none`. */
  withheld: boolean;
}

/**
 * The wire `tools` after the withheld-tools rule (D3, L1, L12): a non-empty caller array is mapped and
 * remembered; an empty or missing one, while the history holds tool blocks, re-sends the remembered array
 * (docs: send `tool_choice: none` and do not remove `tools`, because editing `tools` invalidates thinking
 * blocks and the prompt cache).
 */
export function resolveWireTools(
  requestTools: readonly ToolDefinition[] | undefined,
  historyToolNames: readonly string[],
  memory: ToolsMemory,
  options: { remember?: boolean } = {},
): WireTools {
  if (requestTools && requestTools.length > 0) {
    const mapped = toAnthropicTools(requestTools);
    if (options.remember !== false) memory.remember(mapped);
    return { tools: mapped, withheld: false };
  }
  if (historyToolNames.length === 0) return { withheld: false };
  return { tools: memory.resolveWithheld(historyToolNames), withheld: true };
}

// ── History (D3) ──

interface Work { role: 'user' | 'assistant'; blocks: AnthropicBlock[]; edited: boolean }

export interface ConvertedHistory {
  system?: string;
  messages: AnthropicMessage[];
  /** Indexes (into `messages`) of assistant messages whose replayed `tool_use` input differs from the response's own (guard log line / `drop_run`). */
  edited: number[];
  /** Names of `tool_use` blocks in order of first appearance. */
  toolNames: string[];
  imageCount: number;
  notes: {
    droppedEmptyRows: number;
    mergedRows: number;
    prependedLeadingUser: boolean;
    droppedOrphanResults: number;
    stubResults: number;
  };
}

const isToolUse = (block: AnthropicBlock): block is AnthropicToolUseBlock => block.type === 'tool_use';
const isToolResult = (block: AnthropicBlock): block is AnthropicToolResultBlock => block.type === 'tool_result';
const isThinking = (block: AnthropicBlock) => block.type === 'thinking' || block.type === 'redacted_thinking';

/** A row with no text, image or tool block says nothing (`text` has `minLength` 1); thinking alone does not count. */
const isEmptyWork = (work: Work) => !work.blocks.some(block => block.type === 'text' || block.type === 'image' || block.type === 'tool_use' || block.type === 'tool_result');

function callsById(message: LlmMessage): Map<string, ToolCall> {
  const calls = ((message as { toolCalls?: ToolCall[] }).toolCalls ?? (message as { tool_calls?: ToolCall[] }).tool_calls ?? []) as ToolCall[];
  const map = new Map<string, ToolCall>();
  for (const call of calls) {
    if (call?.id && call.function) map.set(call.id, call);
  }
  return map;
}

function assistantWork(message: LlmMessage, unparseable: Set<string>): Work {
  const calls = callsById(message);
  const blocks: AnthropicBlock[] = [];
  let edited = false;

  const useBlock = (id: unknown, name: unknown, original: unknown, call: ToolCall | undefined): AnthropicToolUseBlock | undefined => {
    if (typeof name !== 'string' || !name) return undefined;
    const safeId = sanitizeToolId(id);
    let input: Record<string, unknown> = isPlainObject(original) ? original : {};
    if (call) {
      const parsed = parseToolArguments(call.function.arguments);
      if (!parsed.ok) unparseable.add(safeId);
      const substituted = parsed.ok ? parsed.value : {};
      if (original !== undefined && canonicalJson(substituted) !== canonicalJson(isPlainObject(original) ? original : {})) edited = true;
      input = substituted;
    }
    return { type: 'tool_use', id: safeId, name, input };
  };

  const output = Array.isArray(message.providerOutput) ? message.providerOutput : [];
  if (output.length > 0) {
    // Replay the response's own blocks verbatim and in order (thinking included, even with empty text: the
    // signature carries the reasoning, and a serializer that skips empty blocks edits the checked prefix).
    for (const item of output as Array<Record<string, unknown>>) {
      if (!isPlainObject(item)) continue;
      if (item.type === 'thinking') {
        if (typeof item.signature === 'string' && item.signature.length > 0) {
          blocks.push({ type: 'thinking', thinking: typeof item.thinking === 'string' ? item.thinking : '', signature: item.signature });
        }
      } else if (item.type === 'redacted_thinking') {
        if (typeof item.data === 'string' && item.data.length > 0) blocks.push({ type: 'redacted_thinking', data: item.data });
      } else if (item.type === 'text') {
        if (hasText(item.text)) blocks.push({ type: 'text', text: item.text });
      } else if (item.type === 'tool_use') {
        const block = useBlock(item.id, item.name, item.input, typeof item.id === 'string' ? calls.get(item.id) : undefined);
        if (block) blocks.push(block);
      }
    }
  } else {
    if (hasText(message.content)) blocks.push({ type: 'text', text: message.content });
    for (const call of calls.values()) {
      const block = useBlock(call.id, call.function.name, undefined, call);
      if (block) blocks.push(block);
    }
  }
  return { role: 'assistant', blocks, edited };
}

function userWork(message: LlmMessage, state: { imageCount: number; contextWindow: number }): Work {
  const blocks: AnthropicBlock[] = [];
  for (const image of message.images ?? []) {
    blocks.push(imageBlockFromDataUrl(image));
    state.imageCount += 1;
  }
  if (hasText(message.content)) blocks.push({ type: 'text', text: message.content });
  return { role: 'user', blocks, edited: false };
}

function toolWork(message: LlmMessage, unparseable: ReadonlySet<string>): Work | undefined {
  const rawId = message.toolCallId ?? (message as { tool_call_id?: string }).tool_call_id;
  if (!rawId) return undefined;
  const id = sanitizeToolId(rawId);
  const text = hasText(message.content) ? message.content : EMPTY_RESULT_TEXT;
  const block: AnthropicToolResultBlock = { type: 'tool_result', tool_use_id: id, content: text, ...(unparseable.has(id) ? { is_error: true as const } : {}) };
  return { role: 'user', blocks: [block], edited: false };
}

function mergeAdjacent(works: Work[], notes: ConvertedHistory['notes']): Work[] {
  const merged: Work[] = [];
  for (const work of works) {
    const last = merged.at(-1);
    if (last && last.role === work.role) {
      last.blocks = [...last.blocks, ...work.blocks];
      last.edited = last.edited || work.edited;
      notes.mergedRows += 1;
    } else {
      merged.push({ ...work, blocks: [...work.blocks] });
    }
  }
  return merged;
}

/** Pair `tool_use` with `tool_result` (D3): orphans out, missing results stubbed, results first and in call order. */
function pairToolBlocks(works: Work[], notes: ConvertedHistory['notes']): void {
  for (let index = 0; index < works.length; index += 1) {
    const work = works[index];
    if (work.role === 'user') {
      const previous = works[index - 1];
      const valid = new Set(previous?.role === 'assistant' ? previous.blocks.filter(isToolUse).map(block => block.id) : []);
      const kept = work.blocks.filter(block => !isToolResult(block) || valid.has(block.tool_use_id));
      notes.droppedOrphanResults += work.blocks.length - kept.length;
      work.blocks = kept;
    }
  }
  for (let index = 0; index < works.length; index += 1) {
    const work = works[index];
    if (work.role !== 'assistant') continue;
    const ids = [...new Set(work.blocks.filter(isToolUse).map(block => block.id))];
    if (ids.length === 0) continue;
    let next = works[index + 1];
    if (!next || next.role !== 'user') {
      next = { role: 'user', blocks: [], edited: false };
      works.splice(index + 1, 0, next);
    }
    const results = new Map<string, AnthropicToolResultBlock>();
    for (const block of next.blocks) {
      if (isToolResult(block) && !results.has(block.tool_use_id)) results.set(block.tool_use_id, block);
    }
    const ordered = ids.map(id => {
      const existing = results.get(id);
      if (existing) return existing;
      notes.stubResults += 1;
      return { type: 'tool_result' as const, tool_use_id: id, content: STUB_RESULT_TEXT, is_error: true as const };
    });
    next.blocks = [...ordered, ...next.blocks.filter(block => !isToolResult(block))];
  }
}

/**
 * Convert BotBoy's provider-neutral messages into Messages `system` + `messages` and apply the history
 * rules in order (D3, F2): drop rows with nothing to say; merge consecutive same-role rows; prepend a fixed
 * user line when the first message is not a user turn; drop an orphan `tool_result`; give every `tool_use`
 * a `tool_result` (an `is_error` stub rather than an invalid request); the request must end with a user turn.
 */
export function convertHistory(
  source: readonly LlmMessage[],
  options: { contextWindow?: number } = {},
): ConvertedHistory {
  const notes: ConvertedHistory['notes'] = { droppedEmptyRows: 0, mergedRows: 0, prependedLeadingUser: false, droppedOrphanResults: 0, stubResults: 0 };
  const state = { imageCount: 0, contextWindow: options.contextWindow ?? 200_000 };
  const systemParts: string[] = [];
  const unparseable = new Set<string>();
  let works: Work[] = [];

  for (const message of source) {
    if (message.role === 'system') {
      if (hasText(message.content)) systemParts.push(message.content);
    } else if (message.role === 'user') {
      works.push(userWork(message, state));
    } else if (message.role === 'assistant') {
      works.push(assistantWork(message, unparseable));
    } else if (message.role === 'tool') {
      const work = toolWork(message, unparseable);
      if (work) works.push(work);
      else notes.droppedOrphanResults += 1;
    }
  }
  if (state.imageCount > MAX_IMAGES_ON_200K_WINDOW && state.contextWindow <= 200_000) {
    throw new AnthropicHistoryError(
      'too_many_images',
      `This conversation carries ${state.imageCount} images; Claude takes at most ${MAX_IMAGES_ON_200K_WINDOW} per request on this model.`,
      'Send fewer images, or start a new chat for the next batch.',
    );
  }

  // Rules 1 to 4, repeated until nothing changes (dropping an orphan can empty a message and re-expose a merge).
  for (let pass = 0; pass < 4; pass += 1) {
    const before = works.map(work => `${work.role}:${work.blocks.length}`).join('|');
    const kept = works.filter(work => !isEmptyWork(work));
    notes.droppedEmptyRows += works.length - kept.length;
    works = mergeAdjacent(kept, notes);
    if (works.length > 0 && works[0].role !== 'user') {
      works.unshift({ role: 'user', blocks: [{ type: 'text', text: OMITTED_LINE }], edited: false });
      notes.prependedLeadingUser = true;
    }
    pairToolBlocks(works, notes);
    if (works.map(work => `${work.role}:${work.blocks.length}`).join('|') === before) break;
  }
  works = mergeAdjacent(works.filter(work => !isEmptyWork(work)), notes);

  if (works.length === 0) {
    throw new AnthropicHistoryError('history_empty', 'There is nothing to send to Claude.', 'Send a message with some text, then try again.');
  }
  if (works.at(-1)!.role !== 'user') {
    throw new AnthropicHistoryError(
      'history_ends_with_assistant',
      'The conversation ends with an assistant message, and Claude does not continue assistant turns.',
      'Send a new message to continue the conversation.',
    );
  }

  const toolNames: string[] = [];
  const edited: number[] = [];
  works.forEach((work, index) => {
    if (work.edited && work.role === 'assistant') edited.push(index);
    for (const block of work.blocks) {
      if (isToolUse(block) && !toolNames.includes(block.name)) toolNames.push(block.name);
    }
  });
  return {
    ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
    messages: works.map(work => ({ role: work.role, content: work.blocks })),
    edited,
    toolNames,
    imageCount: state.imageCount,
    notes,
  };
}

// ── Request body (D2, D4, D5, D7, D8) ──

/** The model's thinking level for this call: Off unless the caller asked to think (D5). */
export function thinkingLevelOf(request: Pick<ChatCompletionRequest, 'think' | 'reasoningEffort'>, defaultEffort: 'low' | 'high' | 'max' = 'low'): LlmThinkingLevel {
  if (request.think !== true) return 'off';
  return request.reasoningEffort ?? defaultEffort;
}

/** A model the key's list does not describe: no thinking, no effort, no schema, output at most 16,384, images allowed (D2). */
export function unknownAnthropicProfile(id: string): AnthropicModelProfile {
  return {
    id, name: id, line: null, lifecycle: 'active', retiresAt: null,
    contextWindow: 200_000, maxOutputTokens: 16_384, structuredOutputs: false,
    thinking: { adaptive: false, enabled: false, disabled: false },
    effort: { low: false, medium: false, high: false, xhigh: false, max: false },
  };
}

/**
 * Extended-only models keep one thinking mode through a tool-use turn (S3): when an earlier assistant message
 * of the current turn carries no thinking block, `thinking` is omitted for this request.
 */
function currentTurnLacksThinking(messages: readonly AnthropicMessage[]): boolean {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' && !message.content.some(isToolResult)) { start = index + 1; break; }
  }
  return messages.slice(start).some(message => message.role === 'assistant' && message.content.some(isToolUse) && !message.content.some(isThinking));
}

export type ResponseMode = 'text' | 'json_object' | 'schema_native' | 'schema_prompt';

export interface BuildBodyInput {
  model: string;
  profile: AnthropicModelProfile;
  history: ConvertedHistory;
  /** The wire tools after the withheld-tools rule. */
  wireTools: WireTools;
  level: LlmThinkingLevel;
  maxTokens: number;
  display: 'summarized' | 'omitted';
  responseFormat?: LlmResponseFormat;
  /** Top-level `cache_control`: set by the caller only for interactive calls that send tools (D8). */
  cache: boolean;
  stream: boolean;
  /** Recovery retry and probe only: opt in to the documented block-binding control (needs the beta header on the wire). */
  binding?: 'drop_block' | 'error';
}

export interface BuiltBody {
  body: AnthropicRequestBody;
  /** What `shapeThinking` chose; `body.thinking` is the final field (extended-only models can drop it mid-turn, the recovery retry adds the binding control). */
  shape: AnthropicThinkingShape;
  responseMode: ResponseMode;
  /** Bounds removed from a native response schema; the caller's validator enforces them. */
  strippedBounds: number;
}

/**
 * One request body. No `temperature`, `top_p`, `top_k`, prefill or `tool_choice` other than `none` is ever
 * produced. Thinking and effort come from `shapeThinking` (which never yields a form the model refuses);
 * `max_tokens` is the requested size plus the thinking allowance, clamped to the model.
 */
export function buildAnthropicBody(input: BuildBodyInput): BuiltBody {
  const { profile, history, wireTools } = input;
  const toolsSent = Boolean(wireTools.tools && wireTools.tools.length > 0);
  const effective = deriveProfile(profile);
  const shape = shapeThinking(profile, {
    level: input.level,
    tools: toolsSent,
    maxTokens: input.maxTokens,
    display: input.display,
  });
  let thinking: AnthropicWireThinking | undefined = shape.thinking;
  if (effective.kind === 'C' && thinking && currentTurnLacksThinking(history.messages)) thinking = undefined;
  if (thinking && input.binding && thinking.type === 'adaptive') {
    thinking = { ...thinking, block_binding: { prefix_mismatch_behavior: input.binding } };
  }

  let system = history.system;
  let responseMode: ResponseMode = 'text';
  let format: AnthropicOutputConfig['format'];
  let strippedBounds = 0;
  const responseFormat = input.responseFormat;
  if (responseFormat?.type === 'json_object') {
    system = withJsonModeInstruction(system);
    responseMode = 'json_object';
  } else if (responseFormat?.type === 'json_schema') {
    if (profile.structuredOutputs) {
      const adapted = adaptSchemaForAnthropic(responseFormat.schema);
      format = { type: 'json_schema', schema: adapted.schema };
      strippedBounds = adapted.stripped.length;
      responseMode = 'schema_native';
    } else {
      // Prompt-only JSON (unknown model, or one that does not list structured outputs): not enforced by the API.
      system = withSchemaPromptInstruction(system, responseFormat.schema);
      responseMode = 'schema_prompt';
    }
  }

  const outputConfig: AnthropicOutputConfig = {
    ...(shape.effort ? { effort: shape.effort } : {}),
    ...(format ? { format } : {}),
  };
  const body: AnthropicRequestBody = {
    model: input.model,
    max_tokens: shape.maxTokens,
    stream: input.stream,
    ...(system ? { system } : {}),
    messages: history.messages,
    ...(toolsSent ? { tools: wireTools.tools } : {}),
    ...(toolsSent && wireTools.withheld ? { tool_choice: { type: 'none' as const } } : {}),
    ...(thinking ? { thinking } : {}),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
    ...(input.cache && toolsSent ? { cache_control: { type: 'ephemeral' as const } } : {}),
  };
  return { body, shape, responseMode, strippedBounds };
}

// ── Request size (D7) ──

const IMAGE_MARKER = '"source":{"type":"base64","media_type":"';

/**
 * Size accounting for a serialized Messages body. `providerRequestSize` counts `data:image/` URLs and would see
 * zero Anthropic images, so `requireImageFree` would pass vacuously; this counts base64 image blocks instead.
 * Our own serialization puts the marker in a fixed key order, and a quote inside any text is escaped, so the
 * marker cannot appear inside user text.
 */
export function measureAnthropicRequest(bodyStr: string): ProviderRequestSize {
  let cursor = 0;
  let imageCount = 0;
  let imageChars = 0;
  for (;;) {
    const start = bodyStr.indexOf(IMAGE_MARKER, cursor);
    if (start < 0) break;
    const dataKey = bodyStr.indexOf('"data":"', start);
    if (dataKey < 0) break;
    const dataStart = dataKey + '"data":"'.length;
    const end = bodyStr.indexOf('"', dataStart);
    const boundary = end < 0 ? bodyStr.length : end;
    imageCount += 1;
    imageChars += boundary - dataStart;
    cursor = boundary + 1;
  }
  return { bodyChars: bodyStr.length, bodyBytes: Buffer.byteLength(bodyStr, 'utf8'), imageCount, imageChars };
}

// ── Usage and stop reasons (D3) ──

function tokens(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : null;
}

/**
 * Provider accounting for one Messages `usage` object. Input = `input_tokens` + cache creation + cache read
 * (cache stays a subset of input, like the other providers); reasoning = `output_tokens_details.thinking_tokens`
 * (a subset of `output_tokens`). Missing values stay null, never zero.
 */
export function mapAnthropicUsage(usage: unknown): ParsedProviderUsage {
  if (!isPlainObject(usage)) return emptyProviderUsage();
  const base = tokens(usage.input_tokens);
  const created = tokens(usage.cache_creation_input_tokens);
  const read = tokens(usage.cache_read_input_tokens);
  const output = tokens(usage.output_tokens);
  const details = isPlainObject(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const input = base === null && created === null && read === null ? null : (base ?? 0) + (created ?? 0) + (read ?? 0);
  return {
    reported: true,
    inputTokens: input,
    outputTokens: output,
    totalTokens: input !== null && output !== null ? input + output : null,
    cacheReadTokens: read,
    cacheWriteTokens: created,
    reasoningTokens: tokens(details.thinking_tokens),
  };
}

/** The `LlmUsage` the chat loop shows, from parsed accounting (missing values read as zero, as for the other providers). */
export function toLlmUsage(parsed: ParsedProviderUsage): LlmUsage {
  const promptTokens = parsed.inputTokens ?? 0;
  const completionTokens = parsed.outputTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: parsed.totalTokens ?? promptTokens + completionTokens,
    ...(parsed.cacheReadTokens !== null ? { cacheReadTokens: parsed.cacheReadTokens } : {}),
    ...(parsed.cacheWriteTokens !== null ? { cacheWriteTokens: parsed.cacheWriteTokens } : {}),
  };
}

export type FinishReason = 'stop' | 'tool_calls' | 'length';

/** `end_turn`, `stop_sequence`, `pause_turn`, `refusal` → stop; `tool_use` → tool_calls; `max_tokens`, `model_context_window_exceeded` → length. */
export function mapStopReason(stopReason: unknown, hasToolCalls: boolean): FinishReason {
  if (stopReason === 'tool_use') return hasToolCalls ? 'tool_calls' : 'stop';
  if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') return 'length';
  return hasToolCalls ? 'tool_calls' : 'stop';
}

// ── SSE framing and reduction (D6) ──

export interface SseFrame { event: string | null; data: string }

/**
 * Incremental SSE parser: `event:` and `data:` fields, comments ignored, multi-line data joined with `\n`, a
 * blank line dispatches. A new `event:` while data is pending also dispatches, so a stream without blank
 * separators still parses. Chunks may split anywhere, including inside a line or a multi-byte character
 * (the caller decodes with a streaming `TextDecoder`).
 */
export function createSseFrameParser(): { push(text: string): SseFrame[]; flush(): SseFrame[] } {
  let buffer = '';
  let endedWithCarriageReturn = false;
  let event: string | null = null;
  let data: string[] = [];
  const frames: SseFrame[] = [];
  const dispatch = () => {
    if (data.length > 0) frames.push({ event, data: data.join('\n') });
    event = null;
    data = [];
  };
  const handleLine = (line: string) => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      if (data.length > 0) dispatch();
      event = value;
    } else if (field === 'data') {
      data.push(value);
    }
  };
  return {
    push(text) {
      // A chunk that starts with "\n" right after one that ended with "\r" completes a "\r\n": it is not a new line.
      if (endedWithCarriageReturn && text.startsWith('\n')) text = text.slice(1);
      if (text.length === 0) return frames.splice(0, frames.length);
      endedWithCarriageReturn = text.endsWith('\r');
      buffer += text;
      const lines = buffer.split(/\r\n|\r|\n/);
      // The last element is the (possibly incomplete) line the next chunk continues.
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
      return frames.splice(0, frames.length);
    },
    flush() {
      if (buffer) handleLine(buffer);
      buffer = '';
      dispatch();
      return frames.splice(0, frames.length);
    },
  };
}

type AccBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; thinking: string; signature: string }
  | { kind: 'redacted_thinking'; data: string }
  | { kind: 'tool_use'; id: string; name: string; initialInput: unknown; partial: string; ordinal: number; stopped: boolean };

export interface AnthropicStreamOutcome {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  /** The response's content blocks in order, for verbatim replay (thinking and signatures included). */
  providerOutput: AnthropicBlock[];
  finishReason: FinishReason;
  stopReason: string | null;
  usage: ParsedProviderUsage;
  thinkingBlocks: number;
  messageId?: string;
}

export interface StreamReducer {
  /** Feed one parsed event; returns the chunks to forward. Throws `AnthropicApiError` for an `error` event. */
  push(event: unknown): StreamChunk[];
  /** true once `message_stop` arrived. */
  readonly stopped: boolean;
  /** Usage so far (cumulative merge of `message_start` and every `message_delta`). */
  readonly usage: ParsedProviderUsage;
  /** The final result; throws when the stream ended without `message_stop`. */
  finish(): AnthropicStreamOutcome;
}

const REFUSAL_NOTE = (category: unknown) =>
  `Claude declined to answer this request${typeof category === 'string' && category ? ` (reason: ${redactProviderSecrets(category).slice(0, 80)})` : ''}.`;

export function createAnthropicStreamReducer(options: {
  /** The caller sent tools this turn; tool_use blocks are ignored when it did not (tools were withheld on purpose). */
  toolsOffered: boolean;
  /** Remove one outer markdown fence from the answer (JSON-mode shim and prompt-only schema output). */
  normalizeJson?: boolean;
}): StreamReducer {
  const blocks = new Map<number, AccBlock>();
  let toolOrdinal = 0;
  let stopReason: string | null = null;
  let stopDetails: unknown;
  let messageId: string | undefined;
  let stopped = false;
  const merged: Record<string, unknown> = {};

  const mergeUsage = (usage: unknown) => {
    if (!isPlainObject(usage)) return;
    for (const [key, value] of Object.entries(usage)) {
      if (value !== undefined && value !== null) merged[key] = value;
    }
  };

  const push = (event: unknown): StreamChunk[] => {
    if (!isPlainObject(event)) return [];
    const chunks: StreamChunk[] = [];
    switch (event.type) {
      case 'message_start': {
        const message = isPlainObject(event.message) ? event.message : {};
        if (typeof message.id === 'string') messageId = message.id;
        mergeUsage(message.usage);
        break;
      }
      case 'content_block_start': {
        const index = Number(event.index);
        const block = isPlainObject(event.content_block) ? event.content_block : {};
        if (!Number.isInteger(index) || index < 0) break;
        if (block.type === 'text') {
          blocks.set(index, { kind: 'text', text: typeof block.text === 'string' ? block.text : '' });
          if (typeof block.text === 'string' && block.text) chunks.push({ type: 'content', text: block.text });
        } else if (block.type === 'thinking') {
          blocks.set(index, {
            kind: 'thinking',
            thinking: typeof block.thinking === 'string' ? block.thinking : '',
            signature: typeof block.signature === 'string' ? block.signature : '',
          });
        } else if (block.type === 'redacted_thinking') {
          blocks.set(index, { kind: 'redacted_thinking', data: typeof block.data === 'string' ? block.data : '' });
        } else if (block.type === 'tool_use') {
          // The chunk index is the tool ordinal, not the content-block index.
          const ordinal = toolOrdinal;
          if (options.toolsOffered) toolOrdinal += 1;
          const id = typeof block.id === 'string' && block.id ? block.id : `toolu_${index}`;
          const name = typeof block.name === 'string' ? block.name : '';
          blocks.set(index, { kind: 'tool_use', id, name, initialInput: block.input, partial: '', ordinal, stopped: false });
          if (options.toolsOffered) chunks.push({ type: 'tool_call_start', toolCall: { index: ordinal, id, name } });
        }
        break;
      }
      case 'content_block_delta': {
        const index = Number(event.index);
        const delta = isPlainObject(event.delta) ? event.delta : {};
        const block = blocks.get(index);
        if (!block) break;
        if (delta.type === 'text_delta' && block.kind === 'text' && typeof delta.text === 'string') {
          block.text += delta.text;
          if (delta.text) chunks.push({ type: 'content', text: delta.text });
        } else if (delta.type === 'thinking_delta' && block.kind === 'thinking' && typeof delta.thinking === 'string') {
          block.thinking += delta.thinking;
          // Empty deltas (display "omitted") are never forwarded; the block itself is kept for replay.
          if (delta.thinking) chunks.push({ type: 'thinking', text: delta.thinking });
        } else if (delta.type === 'signature_delta' && block.kind === 'thinking' && typeof delta.signature === 'string') {
          block.signature += delta.signature;
        } else if (delta.type === 'input_json_delta' && block.kind === 'tool_use' && typeof delta.partial_json === 'string') {
          block.partial += delta.partial_json;
          if (options.toolsOffered && delta.partial_json) chunks.push({ type: 'tool_call_args', toolCall: { index: block.ordinal, arguments: delta.partial_json } });
        }
        break;
      }
      case 'content_block_stop': {
        const block = blocks.get(Number(event.index));
        if (block?.kind === 'tool_use') block.stopped = true;
        break;
      }
      case 'message_delta': {
        const delta = isPlainObject(event.delta) ? event.delta : {};
        if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
        if (delta.stop_details !== undefined) stopDetails = delta.stop_details;
        // Usage in message_delta is cumulative: later values replace earlier ones.
        mergeUsage(event.usage);
        break;
      }
      case 'message_stop':
        stopped = true;
        break;
      case 'error': {
        const error = isPlainObject(event.error) ? event.error : {};
        const type = typeof error.type === 'string' ? error.type : 'api_error';
        const body = JSON.stringify({ type: 'error', error: { type, message: typeof error.message === 'string' ? error.message : '' }, ...(typeof event.request_id === 'string' ? { request_id: event.request_id } : {}) });
        throw new AnthropicApiError(classifyAnthropicHttpError(statusForAnthropicErrorType(type), { get: () => null }, body));
      }
      default:
        // `ping` and event types added later are ignored (the versioning policy asks for graceful handling).
        break;
    }
    return chunks;
  };

  const finish = (): AnthropicStreamOutcome => {
    if (!stopped) throw new Error('Anthropic stream terminated before message_stop');
    const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
    const providerOutput: AnthropicBlock[] = [];
    const toolCalls: ToolCall[] = [];
    let content = '';
    let reasoning = '';
    let thinkingBlocks = 0;
    for (const block of ordered) {
      if (block.kind === 'text') {
        content += block.text;
        if (block.text) providerOutput.push({ type: 'text', text: block.text });
      } else if (block.kind === 'thinking') {
        reasoning += block.thinking;
        thinkingBlocks += 1;
        providerOutput.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
      } else if (block.kind === 'redacted_thinking') {
        thinkingBlocks += 1;
        providerOutput.push({ type: 'redacted_thinking', data: block.data });
      } else if (options.toolsOffered && block.name) {
        // Keep the streamed string as the call's arguments (chat's repair path judges unparseable text); the replayed
        // block holds the parsed object, or {} when it never parsed.
        const raw = block.partial.trim() ? block.partial : (isPlainObject(block.initialInput) && Object.keys(block.initialInput).length ? JSON.stringify(block.initialInput) : '{}');
        const parsed = parseToolArguments(raw);
        toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: raw } });
        providerOutput.push({ type: 'tool_use', id: block.id, name: block.name, input: parsed.ok ? parsed.value : {} });
      }
    }
    if (!content && stopReason === 'refusal') {
      content = REFUSAL_NOTE(isPlainObject(stopDetails) ? stopDetails.category : undefined);
    }
    if (options.normalizeJson && content) content = normalizeJsonModeText(content);
    const usage = mapAnthropicUsage(Object.keys(merged).length ? merged : undefined);
    return {
      content,
      reasoning,
      toolCalls,
      providerOutput,
      finishReason: mapStopReason(stopReason, toolCalls.length > 0),
      stopReason,
      usage,
      thinkingBlocks,
      ...(messageId ? { messageId } : {}),
    };
  };

  return {
    push,
    get stopped() { return stopped; },
    get usage() { return mapAnthropicUsage(Object.keys(merged).length ? merged : undefined); },
    finish,
  };
}
