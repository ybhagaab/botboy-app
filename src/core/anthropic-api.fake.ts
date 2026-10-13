/**
 * A fake Anthropic API for tests and the owner-run probe's `--base-url` mode
 * (design v3 section 6). It serves `GET /v1/models` (paging, capability
 * variants A/B/C/D and `capabilities: null`), `POST /v1/messages` (JSON and
 * SSE) and `POST /v1/messages/count_tokens` with the same validation, and every
 * row of the D10 error table. The model list is an argument (the real list
 * reduced to public ids lives in `testdata/` and is read by tests only, so
 * `tsc` never imports it).
 *
 * The fake enforces what the docs say about what a model accepts, from the
 * model's OWN `capabilities` (like the real API: `disabled.supported` is false
 * exactly when a request that sends it gets a 400), not from BotBoy's known
 * table. A test that feeds a built request body through the fake therefore
 * proves BotBoy never sends a form the model refuses. What the docs leave open
 * is a switch, so both outcomes are tested: a top-level combinator in a tool
 * `input_schema`, a leading assistant message, and the two thinking-replay
 * checks (S22 prefix, S9 latest run). Replies are scripted per request
 * (`fake.reply`), SSE has pings, chunking, gaps, buffered versus eager tool
 * input, truncation and an `error` event; the documentation's own sample
 * streams live in `testdata/anthropic-sse/`.
 *
 * Ships with `src` like the other `*.fake.ts` files; it holds no credentials:
 * the key below is assembled from parts at load time.
 */
import { createHash } from 'node:crypto';
import http from 'http';
import type { AddressInfo } from 'net';

/** Assembled at runtime so no key-shaped literal sits in source. Passes the Anthropic key shape. */
export const FAKE_ANTHROPIC_KEY = ['sk', 'ant', 'api03', `fake${'0123456789abcdef'.repeat(2)}-test`].join('-');

export type FakeCapabilityVariant = 'A' | 'B' | 'C' | 'D' | 'null';

export interface FakeEffortSupport {
  low: boolean;
  medium: boolean;
  high: boolean;
  xhigh: boolean;
  max: boolean;
}

const EFFORT_FULL: FakeEffortSupport = { low: true, medium: true, high: true, xhigh: true, max: true };
const EFFORT_OFF: FakeEffortSupport = { low: false, medium: false, high: false, xhigh: false, max: false };

const leaf = (supported: boolean) => ({ supported });

/** `capabilities` as `GET /v1/models` returns it for one thinking profile (S6). Pass `null` variant for a null object. */
export function fakeCapabilities(
  variant: FakeCapabilityVariant,
  options: { images?: boolean; structuredOutputs?: boolean; effort?: Partial<FakeEffortSupport> } = {},
): Record<string, unknown> | null {
  if (variant === 'null') return null;
  const thinking = {
    A: { supported: true, types: { adaptive: leaf(true), enabled: leaf(false), disabled: leaf(false) } },
    B: { supported: true, types: { adaptive: leaf(true), enabled: leaf(false), disabled: leaf(true) } },
    C: { supported: true, types: { adaptive: leaf(false), enabled: leaf(true), disabled: leaf(true) } },
    // The Models API reports `disabled.supported` true on a model that does not support thinking at all.
    D: { supported: false, types: { adaptive: leaf(false), enabled: leaf(false), disabled: leaf(true) } },
  }[variant];
  // Extended-only and no-thinking models take no effort unless a test says so (Opus 4.5 does).
  const levels = { ...(variant === 'C' || variant === 'D' ? EFFORT_OFF : EFFORT_FULL), ...options.effort };
  const anyEffort = Object.values(levels).some(Boolean);
  return {
    batch: leaf(true),
    citations: leaf(true),
    code_execution: leaf(false),
    context_management: { supported: false },
    effort: { supported: anyEffort, low: leaf(levels.low), medium: leaf(levels.medium), high: leaf(levels.high), xhigh: leaf(levels.xhigh), max: leaf(levels.max) },
    image_input: leaf(options.images ?? true),
    pdf_input: leaf(true),
    structured_outputs: leaf(options.structuredOutputs ?? variant !== 'D'),
    thinking,
  };
}

export interface FakeModelSpec {
  id: string;
  name?: string;
  line?: string | null;
  lifecycle?: 'active' | 'deprecated' | 'retired';
  retiresAt?: string | null;
  variant: FakeCapabilityVariant;
  images?: boolean;
  structuredOutputs?: boolean;
  effort?: Partial<FakeEffortSupport>;
  maxInputTokens?: number | null;
  maxTokens?: number | null;
}

/** One `ModelInfo` row (S6). */
export function fakeModelRow(spec: FakeModelSpec): Record<string, unknown> {
  const lifecycle = spec.lifecycle ?? 'active';
  return {
    type: 'model',
    id: spec.id,
    display_name: spec.name ?? spec.id,
    created_at: '2026-01-01T00:00:00Z',
    deprecated_at: lifecycle === 'active' ? null : '2026-09-01T00:00:00Z',
    lifecycle,
    line: spec.line === undefined ? null : spec.line,
    max_input_tokens: spec.maxInputTokens === undefined ? 1_000_000 : spec.maxInputTokens,
    max_tokens: spec.maxTokens === undefined ? 128_000 : spec.maxTokens,
    retires_at: spec.retiresAt ?? null,
    capabilities: fakeCapabilities(spec.variant, { images: spec.images, structuredOutputs: spec.structuredOutputs, effort: spec.effort }),
  };
}

/** A small hand-written list (newest first) covering every profile; real-list tests pass their own. */
export const FAKE_DEFAULT_MODELS: readonly FakeModelSpec[] = Object.freeze([
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', line: 'sonnet', variant: 'A' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', line: 'haiku', variant: 'B' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', line: 'opus', variant: 'A' },
  { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', line: 'opus', variant: 'C', effort: { low: true, medium: true, high: true }, maxInputTokens: 200_000, maxTokens: 64_000 },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', line: 'haiku', variant: 'C', maxInputTokens: 200_000, maxTokens: 64_000 },
] satisfies FakeModelSpec[]);

export interface FakeRecordedRequest {
  method: string;
  path: string;
  query: Record<string, string[]>;
  /** Header names are lower case. */
  headers: Record<string, string>;
  /** How the caller authenticated: the header style and the key it sent. */
  auth: { style: 'x-api-key' | 'bearer' | 'none'; key: string };
  body?: any;
  /** The raw body text as sent. */
  rawBody: string;
}

export interface FakeErrorAnswer {
  status: number;
  /** An object is sent as JSON; a string is sent as is (a Cloudflare HTML page, for example). */
  body?: unknown;
  headers?: Record<string, string>;
}

/** The Anthropic error envelope (S9). */
export function fakeErrorBody(type: string, message: string, extra: Record<string, unknown> = {}): unknown {
  return { type: 'error', error: { type, message, ...extra }, request_id: 'req_fake0123456789' };
}

/** Every row of the D10 table as the API would send it. Tests iterate this once. */
export const FAKE_D10_ROWS: readonly { name: string; answer: FakeErrorAnswer }[] = Object.freeze([
  { name: '401 authentication_error', answer: { status: 401, body: fakeErrorBody('authentication_error', 'invalid x-api-key') } },
  { name: '402 billing_error', answer: { status: 402, body: fakeErrorBody('billing_error', 'Your credit balance is too low to access the Anthropic API.') } },
  { name: '400 owner spend limit', answer: { status: 400, body: fakeErrorBody('invalid_request_error', 'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.') } },
  { name: '429 tier spend cap', answer: { status: 429, body: fakeErrorBody('rate_limit_error', 'Monthly spend cap reached', { details: { error_code: 'enforced_spend_limit_reached' } }) } },
  { name: '400 workspace id required', answer: { status: 400, body: fakeErrorBody('invalid_request_error', 'anthropic-workspace-id is required for this credential') } },
  { name: '400 other', answer: { status: 400, body: fakeErrorBody('invalid_request_error', 'max_tokens: field required') } },
  { name: '403 permission_error', answer: { status: 403, body: fakeErrorBody('permission_error', 'Your API key does not have permission to use the specified resource.') } },
  { name: '404 not_found_error', answer: { status: 404, body: fakeErrorBody('not_found_error', 'model: claude-gone') } },
  { name: '409 conflict_error', answer: { status: 409, body: fakeErrorBody('conflict_error', 'conflict') } },
  { name: '413 request_too_large (Cloudflare page)', answer: { status: 413, body: '<html><head><title>413 Request Entity Too Large</title></head><body>cloudflare</body></html>' } },
  { name: '429 rate_limit_error', answer: { status: 429, headers: { 'retry-after': '3' }, body: fakeErrorBody('rate_limit_error', 'rate limited') } },
  { name: '529 overloaded_error', answer: { status: 529, body: fakeErrorBody('overloaded_error', 'Overloaded') } },
  { name: '500 api_error', answer: { status: 500, body: fakeErrorBody('api_error', 'Internal server error') } },
  { name: '504 timeout_error', answer: { status: 504, body: fakeErrorBody('timeout_error', 'Request timed out') } },
]);

/** A model-id test: a boolean for every model, or a function of the id. */
export type FakeModelPredicate = boolean | ((modelId: string) => boolean);
const applies = (predicate: FakeModelPredicate | undefined, id: string): boolean =>
  typeof predicate === 'function' ? predicate(id) : predicate === true;

export interface FakeAnthropicOptions {
  /** Model rows the key lists (specs are expanded with `fakeModelRow`). Default: `FAKE_DEFAULT_MODELS`. */
  models?: readonly (FakeModelSpec | Record<string, unknown>)[];
  /** Rows per page; default honors the request's `limit` (the real maximum is 1000). */
  pageSize?: number;
  /** Keys that authenticate. Default: `[FAKE_ANTHROPIC_KEY]`. */
  keys?: readonly string[];
  /** Header styles that authenticate. Default: both (the guide documents both). */
  authStyles?: readonly ('x-api-key' | 'bearer')[];
  /** Serve `retired` rows even when not requested (a misbehaving server; the client must still drop them). */
  leakRetired?: boolean;
  /**
   * Neither of these is documented, so each is a switch and both outcomes are tested.
   * A tool `input_schema` with a top-level `oneOf|anyOf|allOf|not`: rejected by default (the conservative
   * assumption BotBoy's sanitizer is built on).
   */
  rejectTopLevelCombinator?: boolean;
  /** A conversation whose first message is the assistant's: `'reject'` by default (A1 behavior). */
  leadingAssistant?: 'reject' | 'allow';
  /**
   * The two thinking-replay checks, off by default (accounts older than 2026-08-31 enforce the prefix only when a
   * request opts in with the beta field). `prefix`: a thinking block whose recorded prefix differs answers the S22
   * 400; `latestRun`: a partial or changed thinking run in the latest assistant message answers the S9 400.
   */
  thinkingChecks?: { prefix?: FakeModelPredicate; latestRun?: FakeModelPredicate };
  /** count_tokens validates exactly like Messages (documented). `false` models a server that accepts anything (probe P3 self-test). */
  countTokensValidates?: boolean;
  /** Models for which `tool_choice` any/tool is a 400 (S9). Default: Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1. */
  forcedToolChoiceRejected?: FakeModelPredicate;
}

/** One block of a scripted reply. Missing signatures, data and ids are generated. */
export type FakeReplyBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data?: string }
  | { type: 'tool_use'; id?: string; name: string; input?: Record<string, unknown>; /** Stream exactly this text as the arguments (an unparseable cut-off, for example). */ rawInput?: string };

export interface FakeStreamOptions {
  /** Characters per text, thinking and tool-input delta. Default 24. */
  chunk?: number;
  /** Send a `ping` after `message_start` and between blocks. */
  pings?: boolean;
  /** Pause before every event after the first. */
  gapMs?: number;
  /** Eager tools (`eager_input_streaming` in the request) space their input deltas by this. */
  toolInputGapMs?: number;
  /** Buffered tools stay silent this long before emitting any input delta (S19), then emit them back to back. */
  toolInputDelayMs?: number;
  /** End the response after this many events, with no `message_stop`. */
  truncateAfter?: number;
  /** Drop the connection after this many events (a network reset mid-stream): the client's read fails, not a clean end. */
  resetAfter?: number;
  /** Send an `error` event after this many events (default: after the last block) and end. */
  error?: { type: string; message: string; afterEvents?: number };
}

export interface FakeMessageReply {
  content?: FakeReplyBlock[];
  stopReason?: string;
  stopDetails?: unknown;
  /** `usage` in `message_start`; computed from the request when omitted. */
  usage?: Record<string, unknown>;
  /** `usage` in `message_delta` (cumulative); computed when omitted. */
  finalUsage?: Record<string, unknown>;
  stream?: FakeStreamOptions;
}

export interface FakeAnthropicServer {
  /** Base URL without `/v1`, as `--base-url` and `ANTHROPIC_API_ENDPOINT` take it. */
  url: string;
  requests: FakeRecordedRequest[];
  /** Consulted after authentication for every request; a returned answer replaces the normal one. */
  respond?: (request: FakeRecordedRequest) => FakeErrorAnswer | undefined;
  /** Script a Messages reply (or answer an error) for one request; returning undefined uses the default `pong`. */
  reply?: (request: FakeRecordedRequest) => FakeMessageReply | FakeErrorAnswer | undefined;
  /** Replace the served list between requests. */
  setModels(models: readonly (FakeModelSpec | Record<string, unknown>)[]): void;
  /** Answer the next N requests by dropping their connection without a response. */
  dropNext: number;
  /** Thinking blocks the fake produced: key `signature` or `r:<data>` → the run they belong to. Tests read it; nothing else does. */
  readonly generated: ReadonlyMap<string, { run: string[]; prefix: string; model: string }>;
  close(): Promise<void>;
}

function isSpec(value: FakeModelSpec | Record<string, unknown>): value is FakeModelSpec {
  return typeof (value as FakeModelSpec).variant === 'string';
}

function expandRows(models: readonly (FakeModelSpec | Record<string, unknown>)[]): Record<string, unknown>[] {
  return models.map(model => (isSpec(model) ? fakeModelRow(model) : model));
}

const THINKING_FORM_TEXT = {
  enabled: '`thinking.type.enabled` is not supported for this model. Use `thinking.type.adaptive` and `output_config.effort` to control thinking behavior.',
  disabled: '`thinking.type.disabled` is not supported for this model.',
  adaptive: '`thinking.type.adaptive` is not supported for this model. Use `thinking.type.enabled` with `budget_tokens`.',
} as const;

/**
 * What the model accepts, from its own `capabilities` (documented 400s only):
 * a thinking form it does not list, an effort level it does not list,
 * `disabled` next to effort `xhigh` or `max`, a manual budget under 1,024 or
 * not below `max_tokens`, and `max_tokens` above the model's maximum.
 */
export function validateFakeMessagesBody(row: Record<string, any>, body: any): { status: number; message: string } | undefined {
  const caps = row.capabilities;
  const maxOutput = Number.isInteger(row.max_tokens) && row.max_tokens > 0 ? row.max_tokens : undefined;
  if (!Number.isInteger(body?.max_tokens) || body.max_tokens < 1) return { status: 400, message: 'max_tokens: field required' };
  if (maxOutput && body.max_tokens > maxOutput) return { status: 400, message: `max_tokens: ${body.max_tokens} > ${maxOutput}, which is the maximum allowed number of output tokens for ${row.id}` };
  const thinking = body.thinking;
  if (thinking !== undefined) {
    const type = String(thinking?.type);
    const types = caps?.thinking?.types;
    const supported = type === 'disabled'
      ? types?.disabled?.supported === true
      : caps?.thinking?.supported === true && types?.[type]?.supported === true;
    if (!supported) return { status: 400, message: THINKING_FORM_TEXT[type as keyof typeof THINKING_FORM_TEXT] ?? `thinking.type: ${type} is not supported for this model.` };
    if (type === 'enabled') {
      const budget = thinking.budget_tokens;
      if (!Number.isInteger(budget) || budget < 1024) return { status: 400, message: 'thinking.enabled.budget_tokens: Input should be greater than or equal to 1024' };
      if (budget >= body.max_tokens) return { status: 400, message: 'max_tokens must be greater than thinking.budget_tokens' };
    }
  }
  const effort = body.output_config?.effort;
  if (effort !== undefined) {
    if (caps?.effort?.supported !== true || caps?.effort?.[effort]?.supported !== true) {
      return { status: 400, message: `output_config.effort: level ${String(effort)} is not supported for this model` };
    }
    if (thinking?.type === 'disabled' && (effort === 'xhigh' || effort === 'max')) {
      return { status: 400, message: `output_config.effort: effort level \`${effort}\` is not supported when thinking is disabled. To use it, enable thinking.` };
    }
  }
  return undefined;
}

// ── Whole-request validation (Messages and count_tokens) ──

export const FAKE_BINDING_BETA = 'thinking-binding-controls-2026-08-01';
/** The two texts the API answers for a broken thinking replay (S22 lead text, S9/S4 lead text). */
export const FAKE_SIGNATURE_400 = 'Invalid `signature` in `thinking` block';
export const FAKE_LATEST_RUN_400 = '`thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.';

const SCHEMA_REMOVED_KEYWORDS = ['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems'] as const;
const TOP_LEVEL_COMBINATORS = ['oneOf', 'anyOf', 'allOf', 'not'] as const;
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const DEFAULT_FORCED_CHOICE_REJECTED = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-mythos-5-1']);
const knownId = (id: string) => id.replace(/-\d{8}$/, '');
/** Models that reject `temperature`, `top_p` and `top_k` (S3: the 5.x family). */
const rejectsSampling = (id: string) => /^claude-[a-z]+-5(-|$)/.test(knownId(id));

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const isThinkingType = (type: unknown) => type === 'thinking' || type === 'redacted_thinking';
const blockKey = (block: any): string | undefined =>
  block?.type === 'thinking' ? String(block.signature) : block?.type === 'redacted_thinking' ? `r:${String(block.data)}` : undefined;

/**
 * The prefix a thinking block is bound to: `system`, `tools` and every EARLIER message with its thinking blocks
 * left out (S22: earlier thinking blocks are not part of the checked prefix). Deliberately NOT the guard's
 * serialization (which includes kept blocks' ids), so the guard is tested against an independent definition.
 */
function prefixOf(body: any, messages: any[], upto: number): string {
  const earlier = messages.slice(0, upto).map(message => ({
    role: message?.role,
    content: Array.isArray(message?.content) ? message.content.filter((block: any) => !isThinkingType(block?.type)) : message?.content,
  }));
  return sha(canonical({ system: body.system ?? null, tools: body.tools ?? null, messages: earlier }));
}

function schemaProblem(node: unknown, path: string): string | undefined {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const schema = node as Record<string, any>;
  for (const keyword of SCHEMA_REMOVED_KEYWORDS) {
    if (schema[keyword] !== undefined) return `${path}: ${keyword} is not supported by structured outputs`;
  }
  if (schema.minItems !== undefined && schema.minItems !== 0 && schema.minItems !== 1) return `${path}: minItems values other than 0 or 1 are not supported`;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('object') && schema.additionalProperties !== false) return `${path}: additionalProperties must be set to false for objects`;
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    const problem = schemaProblem(child, `${path}.properties.${name}`);
    if (problem) return problem;
  }
  return schema.items ? schemaProblem(schema.items, `${path}.items`) : undefined;
}

interface Validated {
  failure?: { status: number; message: string };
  /** `drop_block` answers: the blocks the server removed instead of failing. */
  transformations: unknown[];
  /** The messages after any `drop_block` removal. */
  messages: any[];
}

function validateRequest(
  row: Record<string, any>,
  body: any,
  context: {
    mode: 'messages' | 'count_tokens';
    headers: Record<string, string>;
    options: FakeAnthropicOptions;
    generated: ReadonlyMap<string, { run: string[]; prefix: string; model: string }>;
  },
): Validated {
  const { options, generated } = context;
  const fail = (message: string): Validated => ({ failure: { status: 400, message }, transformations: [], messages: body?.messages ?? [] });
  const transformations: unknown[] = [];
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return fail('messages: at least one message is required');
  let messages: any[] = body.messages.map((message: any) => ({ ...message }));

  // Sampling parameters and prefill.
  for (const field of ['temperature', 'top_p', 'top_k']) {
    if (body[field] !== undefined && rejectsSampling(row.id)) return fail(`\`${field}\` is not supported for this model.`);
  }
  if (messages.at(-1)?.role === 'assistant') return fail('This model does not support assistant message prefill. The conversation must end with a user message.');
  if (messages[0]?.role !== 'user' && (options.leadingAssistant ?? 'reject') === 'reject') return fail('messages: first message must use the "user" role');

  // Beta and the block-binding control (S2, S22).
  const betas = (context.headers['anthropic-beta'] ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  if (betas.some(beta => beta !== FAKE_BINDING_BETA)) return fail('anthropic-beta: Unexpected value(s) for the `anthropic-beta` header.');
  const binding = body.thinking?.block_binding;
  let bindingMode: 'error' | 'drop_block' | undefined;
  if (binding !== undefined) {
    if (!betas.includes(FAKE_BINDING_BETA)) return fail('thinking.block_binding: Extra inputs are not permitted');
    bindingMode = binding?.prefix_mismatch_behavior;
    if (bindingMode !== 'error' && bindingMode !== 'drop_block') return fail('thinking.block_binding.prefix_mismatch_behavior: Input should be \'error\' or \'drop_block\'');
  }

  // Message structure.
  let imageCount = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'user' && message.role !== 'assistant') return fail(`messages.${index}.role: Input should be 'user' or 'assistant'`);
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (!Array.isArray(content) || content.length === 0) return fail(`messages.${index}.content: must not be empty`);
    let sawNonResult = false;
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = content[blockIndex];
      const where = `messages.${index}.content.${blockIndex}`;
      if (block?.type === 'text') {
        if (typeof block.text !== 'string' || block.text.trim() === '') return fail(`${where}.text: text content blocks must contain non-whitespace text`);
        sawNonResult = true;
      } else if (block?.type === 'image') {
        if (block.source?.type !== 'base64' || !IMAGE_MEDIA_TYPES.has(String(block.source?.media_type)) || typeof block.source?.data !== 'string' || !block.source.data) {
          return fail(`${where}.source: only base64 JPEG, PNG, GIF and WebP images are supported`);
        }
        imageCount += 1;
        sawNonResult = true;
      } else if (block?.type === 'tool_result') {
        if (message.role !== 'user') return fail(`${where}: tool_result blocks belong to user messages`);
        if (sawNonResult) return fail(`${where}: tool_result blocks must come first in the content array`);
      } else if (block?.type === 'tool_use') {
        if (message.role !== 'assistant') return fail(`${where}: tool_use blocks belong to assistant messages`);
        if (!/^[A-Za-z0-9_-]+$/.test(String(block.id))) return fail(`${where}.id: String should match pattern '^[a-zA-Z0-9_-]+$'`);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(block.name))) return fail(`${where}.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$'`);
        if (!block.input || typeof block.input !== 'object' || Array.isArray(block.input)) return fail(`${where}.input: Input should be a valid dictionary`);
        sawNonResult = true;
      } else if (isThinkingType(block?.type)) {
        if (message.role !== 'assistant') return fail(`${where}: thinking blocks belong to assistant messages`);
        sawNonResult = true;
      } else {
        return fail(`${where}.type: unsupported content block type ${String(block?.type)}`);
      }
    }
  }
  if (imageCount > 100 && Number(row.max_input_tokens) <= 200_000) return fail('messages: too many images; at most 100 images are allowed per request for this model');

  // Tool pairing: every tool_use is answered, in the next user message, and nothing else is.
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const content = Array.isArray(message.content) ? message.content : [];
    const uses = content.filter((block: any) => block?.type === 'tool_use').map((block: any) => block.id);
    const next = messages[index + 1];
    const results = Array.isArray(next?.content) ? next.content.filter((block: any) => block?.type === 'tool_result').map((block: any) => block.tool_use_id) : [];
    if (message.role === 'assistant' && uses.length > 0) {
      const missing = uses.filter((id: string) => !results.includes(id));
      if (missing.length > 0) return fail(`messages.${index}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${missing.join(', ')}. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`);
    }
    if (message.role === 'user') {
      const previousUses = messages[index - 1]?.role === 'assistant' && Array.isArray(messages[index - 1].content)
        ? messages[index - 1].content.filter((block: any) => block?.type === 'tool_use').map((block: any) => block.id)
        : [];
      const orphan = content.find((block: any) => block?.type === 'tool_result' && !previousUses.includes(block.tool_use_id));
      if (orphan) return fail(`messages.${index}.content: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${String(orphan.tool_use_id)}. Each \`tool_result\` block must have a corresponding \`tool_use\` block in the previous message.`);
    }
  }

  // Tools and tool choice.
  const tools = body.tools;
  if (tools !== undefined) {
    if (!Array.isArray(tools)) return fail('tools: Input should be a valid list');
    for (let index = 0; index < tools.length; index += 1) {
      const tool = tools[index];
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(tool?.name))) return fail(`tools.${index}.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$'`);
      if (tool.input_schema?.type !== 'object') return fail(`tools.${index}.input_schema.type: Input should be 'object'`);
      if ((options.rejectTopLevelCombinator ?? true) && TOP_LEVEL_COMBINATORS.some(key => tool.input_schema[key] !== undefined)) {
        return fail(`tools.${index}.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level`);
      }
    }
  }
  const choice = body.tool_choice;
  if (choice !== undefined) {
    if (!Array.isArray(tools) || tools.length === 0) return fail('tool_choice: tools must be provided when tool_choice is set');
    if (choice?.type !== 'none' && choice?.type !== 'auto' && applies(options.forcedToolChoiceRejected ?? (id => DEFAULT_FORCED_CHOICE_REJECTED.has(knownId(id))), row.id)) {
      return fail('tool_choice: forced tool use is not supported with thinking on this model');
    }
  }

  // Structured output schema.
  const format = body.output_config?.format;
  if (format !== undefined) {
    if (format?.type !== 'json_schema' || !format.schema || typeof format.schema !== 'object') return fail('output_config.format: Input should be a valid JSON schema format');
    if (row.capabilities?.structured_outputs?.supported !== true) return fail('output_config.format: structured outputs are not supported for this model');
    const problem = schemaProblem(format.schema, 'output_config.format.schema');
    if (problem) return fail(problem);
  }

  // Thinking, effort, max_tokens: the model's own capabilities.
  const shaped = context.mode === 'count_tokens' && body.max_tokens === undefined ? { ...body, max_tokens: Math.max(2048, Number(row.max_tokens) || 2048) } : body;
  const capability = validateFakeMessagesBody(row, shaped);
  if (capability) return fail(capability.message);

  // Thinking replay (S22 prefix, S9 latest run).
  const enforcePrefix = bindingMode !== undefined || applies(options.thinkingChecks?.prefix, row.id);
  const enforceLatest = applies(options.thinkingChecks?.latestRun, row.id);
  if (enforcePrefix || enforceLatest) {
    const latestAssistant = messages.map(message => message.role).lastIndexOf('assistant');
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      const blocks = message.content.filter((block: any) => isThinkingType(block?.type));
      if (blocks.length === 0) continue;
      const now = prefixOf(body, messages, index);
      const records = blocks.map((block: any) => generated.get(blockKey(block) ?? ''));
      if (enforcePrefix) {
        const unknown = records.some((record: unknown) => record === undefined);
        const mismatched = records.some((record: { prefix: string } | undefined) => record !== undefined && record.prefix !== now);
        if (unknown || mismatched) {
          if (bindingMode === 'drop_block') {
            transformations.push({ type: 'dropped_thinking_block', message_index: index, count: blocks.length });
            messages = messages.map((candidate, at) => (at === index ? { ...candidate, content: candidate.content.filter((block: any) => !isThinkingType(block?.type)) } : candidate));
            continue;
          }
          return fail(`messages.${index}.content.${message.content.indexOf(blocks[0])}: ${FAKE_SIGNATURE_400}. Thinking blocks must be replayed against the prefix they were generated for.`);
        }
      }
      if (enforceLatest && index === latestAssistant) {
        const run = records.find((record: unknown) => record !== undefined) as { run: string[] } | undefined;
        if (run) {
          const present = blocks.map((block: any) => blockKey(block));
          const intact = present.length === run.run.length && present.every((key: string | undefined, at: number) => key === run.run[at]);
          if (!intact) return fail(`messages.${index}.content.${message.content.indexOf(blocks[0])}: ${FAKE_LATEST_RUN_400}`);
        }
      }
    }
  }
  return { transformations, messages };
}

// ── Replies ──

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const estimateTokens = (body: any) => Math.max(1, Math.ceil(canonical({ system: body.system ?? null, tools: body.tools ?? null, messages: body.messages }).length / 3.5));

interface SseEvent { type: string; [key: string]: unknown }

function chunksOf(text: string, size: number): string[] {
  if (text === '') return [''];
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += size) parts.push(text.slice(at, at + size));
  return parts;
}

export async function startFakeAnthropic(options: FakeAnthropicOptions = {}): Promise<FakeAnthropicServer> {
  let rows = expandRows(options.models ?? FAKE_DEFAULT_MODELS);
  const keys = new Set(options.keys ?? [FAKE_ANTHROPIC_KEY]);
  const authStyles = new Set(options.authStyles ?? ['x-api-key', 'bearer']);
  const generated = new Map<string, { run: string[]; prefix: string; model: string }>();
  const cachedPrefixes = new Set<string>();
  let counter = 0;
  const fake: FakeAnthropicServer = {
    url: '',
    requests: [],
    respond: undefined,
    reply: undefined,
    setModels(models) { rows = expandRows(models); },
    dropNext: 0,
    generated,
    close: async () => {},
  };

  const server = http.createServer((req, res) => {
    let rawBody = '';
    req.on('data', chunk => { rawBody += chunk; });
    req.on('end', async () => {
      if (fake.dropNext > 0) {
        fake.dropNext -= 1;
        req.socket.destroy();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://fake.local');
      const headers = Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value ?? '')]));
      const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1];
      const auth: FakeRecordedRequest['auth'] = headers['x-api-key']
        ? { style: 'x-api-key', key: headers['x-api-key'] }
        : bearer ? { style: 'bearer', key: bearer } : { style: 'none', key: '' };
      let body: any;
      try { body = rawBody ? JSON.parse(rawBody) : undefined; } catch { body = undefined; }
      const query: Record<string, string[]> = {};
      for (const [name, value] of url.searchParams) (query[name] ??= []).push(value);
      const request: FakeRecordedRequest = { method: req.method ?? 'GET', path: url.pathname, query, headers, auth, body, rawBody };
      fake.requests.push(request);

      const send = (status: number, value: unknown, extra: Record<string, string> = {}) => {
        const isText = typeof value === 'string';
        res.writeHead(status, { 'content-type': isText ? 'text/html' : 'application/json', 'request-id': 'req_fake0123456789', ...extra });
        res.end(isText ? value : JSON.stringify(value));
      };
      const sendAnswer = (answer: FakeErrorAnswer) => send(answer.status, answer.body ?? fakeErrorBody('api_error', 'error'), answer.headers);

      if (auth.style === 'none' || !authStyles.has(auth.style) || !keys.has(auth.key)) {
        return send(401, fakeErrorBody('authentication_error', 'invalid x-api-key'));
      }
      if (headers['anthropic-version'] !== '2023-06-01') {
        return send(400, fakeErrorBody('invalid_request_error', 'anthropic-version: header is required'));
      }
      const custom = fake.respond?.(request);
      if (custom) return sendAnswer(custom);

      // The default reply is the A1 `pong` (JSON or SSE, whichever the request asked for).
      const replyWithMessage = async (row: Record<string, any>, requestBody: any, validated: Validated, reply: FakeMessageReply | undefined): Promise<void> => {
        const omitted = requestBody.thinking?.type === 'adaptive' && requestBody.thinking.display === 'omitted';
        const blocks = (reply?.content ?? [{ type: 'text' as const, text: 'pong' }]).map((block): Record<string, any> => {
          counter += 1;
          if (block.type === 'thinking') return { type: 'thinking', thinking: omitted ? '' : block.thinking, signature: block.signature ?? `sig_fake_${counter}_${sha(String(counter)).slice(0, 12)}` };
          if (block.type === 'redacted_thinking') return { type: 'redacted_thinking', data: block.data ?? `redacted_fake_${counter}_${sha(String(counter)).slice(0, 12)}` };
          if (block.type === 'tool_use') return { type: 'tool_use', id: block.id ?? `toolu_fake_${counter}`, name: block.name, input: block.input ?? {}, ...(block.rawInput !== undefined ? { rawInput: block.rawInput } : {}) };
          return { type: 'text', text: block.text };
        });
        // The run of thinking blocks this response carries, bound to the prefix it was generated against.
        const prefix = prefixOf(requestBody, validated.messages, validated.messages.length);
        const run = blocks.filter(block => isThinkingType(block.type)).map(block => blockKey(block) as string);
        for (const key of run) generated.set(key, { run, prefix, model: String(row.id) });

        const estimate = estimateTokens({ ...requestBody, messages: validated.messages });
        const cacheRequested = requestBody.cache_control !== undefined;
        const cacheKey = sha(canonical({ system: requestBody.system ?? null, tools: requestBody.tools ?? null }));
        const hit = cacheRequested && cachedPrefixes.has(cacheKey);
        if (cacheRequested) cachedPrefixes.add(cacheKey);
        const uncached = cacheRequested ? Math.min(estimate, 12) : estimate;
        const outputTokens = Math.max(1, Math.ceil(blocks.reduce((sum, block) => sum + String(block.text ?? block.thinking ?? JSON.stringify(block.input ?? '')).length, 0) / 4));
        const usage = reply?.usage ?? {
          input_tokens: uncached,
          cache_creation_input_tokens: cacheRequested && !hit ? estimate - uncached : 0,
          cache_read_input_tokens: hit ? estimate - uncached : 0,
          output_tokens: 1,
        };
        const finalUsage = reply?.finalUsage ?? { output_tokens: outputTokens };
        const stopReason = reply?.stopReason ?? (blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn');
        const message = {
          id: `msg_fake_${counter}`,
          type: 'message',
          role: 'assistant',
          model: row.id,
          content: blocks.map(({ rawInput: _raw, ...block }) => (block.type === 'tool_use' && _raw !== undefined ? { ...block, input: {} } : block)),
          stop_reason: stopReason,
          stop_sequence: null,
          ...(reply?.stopDetails !== undefined ? { stop_details: reply.stopDetails } : {}),
          usage: { ...usage, ...finalUsage },
          ...(validated.transformations.length ? { input_transformations: validated.transformations } : {}),
        };
        if (requestBody.stream !== true) return send(200, message);

        // SSE: message_start, each block's start / deltas / stop, message_delta, message_stop.
        const stream = reply?.stream ?? {};
        const size = stream.chunk ?? 24;
        const eagerNames = new Set<string>((requestBody.tools ?? []).filter((tool: any) => tool?.eager_input_streaming === true).map((tool: any) => String(tool.name)));
        const events: Array<SseEvent & { gap?: number }> = [{
          type: 'message_start',
          message: { ...message, content: [], stop_reason: null, usage },
        }];
        if (stream.pings) events.push({ type: 'ping' });
        blocks.forEach((block, index) => {
          const start = block.type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' }
            : block.type === 'redacted_thinking' ? { type: 'redacted_thinking', data: block.data }
            : block.type === 'tool_use' ? { type: 'tool_use', id: block.id, name: block.name, input: {} }
            : { type: 'text', text: '' };
          events.push({ type: 'content_block_start', index, content_block: start });
          if (block.type === 'text') {
            for (const text of chunksOf(block.text, size)) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
          } else if (block.type === 'thinking') {
            for (const thinking of chunksOf(block.thinking, size)) events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } });
            events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
          } else if (block.type === 'tool_use') {
            const eager = eagerNames.has(block.name);
            const text = block.rawInput !== undefined ? block.rawInput : JSON.stringify(block.input);
            chunksOf(text, size).forEach((partial, at) => events.push({
              type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partial },
              gap: eager ? (stream.toolInputGapMs ?? 0) : at === 0 ? (stream.toolInputDelayMs ?? 0) : 0,
            }));
          }
          events.push({ type: 'content_block_stop', index });
          if (stream.pings) events.push({ type: 'ping' });
        });
        events.push({
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null, ...(reply?.stopDetails !== undefined ? { stop_details: reply.stopDetails } : {}) },
          usage: finalUsage,
        });
        events.push({ type: 'message_stop' });
        if (stream.error) events.splice(Math.min(stream.error.afterEvents ?? events.length - 1, events.length - 1), events.length, { type: 'error', error: { type: stream.error.type, message: stream.error.message } });
        const sent = stream.truncateAfter !== undefined ? events.slice(0, stream.truncateAfter) : events;

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_fake0123456789' });
        for (let at = 0; at < sent.length; at += 1) {
          const { gap, ...event } = sent[at];
          const wait = (gap ?? 0) || (at > 0 ? stream.gapMs ?? 0 : 0);
          if (wait > 0) await sleep(wait);
          if (res.destroyed) return;
          const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          if (stream.resetAfter !== undefined && at + 1 >= stream.resetAfter) {
            // Let the client read what was sent, then cut the socket without ending the response.
            await new Promise<void>(resolve => res.write(frame, () => resolve()));
            await sleep(15);
            req.socket.destroy();
            return;
          }
          res.write(frame);
        }
        res.end();
      };

      if (request.method === 'GET' && request.path === '/v1/models') {
        const requested = new Set((query.lifecycle ?? []).flatMap(value => value.split(',')));
        const visible = rows.filter(row => options.leakRetired || row.lifecycle !== 'retired' || requested.has('retired'));
        const limit = Math.min(1000, Math.max(1, Number(query.limit?.[0]) || 20));
        const size = options.pageSize ?? limit;
        const afterId = query.after_id?.[0];
        const start = afterId ? visible.findIndex(row => row.id === afterId) + 1 : 0;
        const page = visible.slice(start, start + Math.min(size, limit));
        return send(200, {
          data: page,
          first_id: page[0]?.id ?? null,
          has_more: start + page.length < visible.length,
          last_id: page[page.length - 1]?.id ?? null,
        });
      }

      const isMessages = request.method === 'POST' && request.path === '/v1/messages';
      const isCount = request.method === 'POST' && request.path === '/v1/messages/count_tokens';
      if (isMessages || isCount) {
        const row = rows.find(candidate => candidate.id === body?.model);
        if (!row || row.lifecycle === 'retired') return send(404, fakeErrorBody('not_found_error', `model: ${String(body?.model)}`));
        if (isCount && options.countTokensValidates === false) return send(200, { input_tokens: estimateTokens(body ?? { messages: [] }) });
        const validated = validateRequest(row, body, { mode: isCount ? 'count_tokens' : 'messages', headers, options, generated });
        if (validated.failure) return send(validated.failure.status, fakeErrorBody('invalid_request_error', validated.failure.message));
        if (isCount) return send(200, { input_tokens: estimateTokens({ ...body, messages: validated.messages }) });

        const scripted = fake.reply?.(request);
        if (scripted && 'status' in scripted) return sendAnswer(scripted);
        await replyWithMessage(row, body, validated, scripted);
        return;
      }

      return send(404, fakeErrorBody('not_found_error', 'Not found'));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  fake.url = `http://127.0.0.1:${port}`;
  fake.close = () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); });
  return fake;
}
