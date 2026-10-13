/**
 * Anthropic (Claude) model knowledge for Settings → AI model (design v3 D1,
 * D2, D8, D10): the key's shape, the key's own model list, the request-shaping
 * profile derived from each model's `capabilities`, default picks, and the
 * Save-time verification.
 *
 * Framework effects (practical-agent-framework):
 *   - Retrieved knowledge: each key's `GET /v1/models` `capabilities`, stored
 *     per key (at most 100 models) and refreshed at boot and save. Nothing
 *     here gates use by id.
 *   - Operating knowledge: `KNOWN_PROFILES` is a closed table of the documented
 *     models. It only ever TIGHTENS what `capabilities` says (a thinking or
 *     effort form is sent only when both allow it) and marks which models run
 *     the thinking-prefix check (`prefixCheck`), which `capabilities` cannot say.
 *
 * Pure and I/O-free except `listAnthropicModels` / `verifyKey`, which take the
 * fetch implementation and endpoint as arguments (the fake server in tests and
 * the owner-run probe use the same code as the app). No key is ever logged,
 * and a request header is built only from a value that passes the key shape.
 */
import {
  AnthropicApiError,
  AnthropicUnreachableError,
  classifyAnthropicHttpError,
  isAnthropicApiError,
} from './anthropic-errors.js';
import type { LlmThinkingLevel } from './llm-model-catalog.js';

export const ANTHROPIC_API_ENDPOINT = 'https://api.anthropic.com';
/** The only current API version; additive changes keep working (S1). No beta headers are ever sent. */
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_MODEL_PAGE_LIMIT = 1000;
export const ANTHROPIC_MAX_MODEL_PAGES = 5;
export const ANTHROPIC_MAX_STORED_MODELS = 100;
/** Save-time verification: about 10 input and at most 16 output tokens. */
export const ANTHROPIC_VERIFY_MAX_TOKENS = 16;
const ANTHROPIC_VERIFY_CANDIDATES = 3;
const LIST_TIMEOUT_MS = 15_000;
const VERIFY_TIMEOUT_MS = 30_000;
const UNKNOWN_CONTEXT_WINDOW = 200_000;
const UNKNOWN_MAX_OUTPUT_TOKENS = 16_384;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const LINE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

// ── Key shape (D10) ──

/** Regular API keys only: `sk-ant-api03-…`. Admin keys (`sk-ant-admin01-…`) serve the Admin API, not models. */
export const ANTHROPIC_KEY_PATTERN = /^sk-ant-(?!admin)[A-Za-z0-9]+-[A-Za-z0-9_-]{16,400}$/;

export function isAnthropicApiKey(value: unknown): value is string {
  return typeof value === 'string' && ANTHROPIC_KEY_PATTERN.test(value);
}

export function isAnthropicAdminKey(value: unknown): boolean {
  return typeof value === 'string' && /^sk-ant-admin/.test(value);
}

/** Any Anthropic-looking key; the OpenAI and DeepSeek cards send it to the Claude card. */
export function looksLikeAnthropicKey(value: unknown): boolean {
  return typeof value === 'string' && /^sk-ant-/.test(value);
}

// ── Auth header (D1) ──

export type AnthropicAuthStyle = 'x-api-key' | 'bearer';
/**
 * `x-api-key` is the header in every API example; the guide's prose leads with
 * Bearer and calls x-api-key legacy. The probe (P1) sends both once. This one
 * constant flips the choice.
 */
export const AUTH_STYLE: AnthropicAuthStyle = 'x-api-key';

/**
 * Request headers for one call. The key is checked against the shape first, so
 * no header can be built from an unvalidated string (no header injection).
 */
export function anthropicRequestHeaders(
  apiKey: string,
  options: { style?: AnthropicAuthStyle; json?: boolean } = {},
): Record<string, string> {
  if (!isAnthropicApiKey(apiKey)) throw new Error('Refusing to send a value that is not an Anthropic API key.');
  const style = options.style ?? AUTH_STYLE;
  return {
    ...(style === 'bearer' ? { Authorization: `Bearer ${apiKey}` } : { 'x-api-key': apiKey }),
    'anthropic-version': ANTHROPIC_VERSION,
    ...(options.json ? { 'content-type': 'application/json' } : {}),
  };
}

// ── Profiles (D2) ──

export type AnthropicLifecycle = 'active' | 'deprecated' | 'retired';
export type AnthropicProfileKind = 'A' | 'B' | 'C' | 'D';
/** How a model honors the chat/role "Thinking · Off" setting (D2 table, last column). */
export type AnthropicThinkingOff = 'native' | 'native_without_tools' | 'lowest_effort' | 'unavailable';

export interface AnthropicThinkingForms {
  readonly adaptive: boolean;
  readonly enabled: boolean;
  readonly disabled: boolean;
}

export interface AnthropicEffortLevels {
  readonly low: boolean;
  readonly medium: boolean;
  readonly high: boolean;
  readonly xhigh: boolean;
  readonly max: boolean;
}

/** One model as the key's list reports it (bounded and validated; stored per key). */
export interface AnthropicModelProfile {
  readonly id: string;
  readonly name: string;
  /** `haiku`, `sonnet`, `opus`, `fable`, `mythos`, later lines; never inferred from the id. */
  readonly line: string | null;
  readonly lifecycle: AnthropicLifecycle;
  readonly retiresAt: string | null;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  /** undefined = unknown (capabilities null or silent); images are allowed then. */
  readonly images?: boolean;
  readonly structuredOutputs: boolean;
  readonly thinking: AnthropicThinkingForms;
  readonly effort: AnthropicEffortLevels;
}

/** The documented models (S3 thinking table, S4 troubleshooting table, S5 effort page). Matched on the id without `-YYYYMMDD`. */
interface KnownProfile {
  readonly thinking: AnthropicThinkingForms;
  readonly effort: AnthropicEffortLevels;
  /** Runs the thinking-prefix check (S22). Gates the replay guard; `capabilities` cannot express it. */
  readonly prefixCheck: boolean;
}

const EFFORT_ALL: AnthropicEffortLevels = { low: true, medium: true, high: true, xhigh: true, max: true };
const EFFORT_TO_MAX: AnthropicEffortLevels = { low: true, medium: true, high: true, xhigh: false, max: true };
const EFFORT_NO_MAX: AnthropicEffortLevels = { low: true, medium: true, high: true, xhigh: false, max: false };
const EFFORT_NONE: AnthropicEffortLevels = { low: false, medium: false, high: false, xhigh: false, max: false };
const ALWAYS_ON: AnthropicThinkingForms = { adaptive: true, enabled: false, disabled: false };
const SWITCHABLE: AnthropicThinkingForms = { adaptive: true, enabled: false, disabled: true };
const SWITCHABLE_WITH_EXTENDED: AnthropicThinkingForms = { adaptive: true, enabled: true, disabled: true };
const EXTENDED_ONLY: AnthropicThinkingForms = { adaptive: false, enabled: true, disabled: true };

export const KNOWN_PROFILES: Readonly<Record<string, KnownProfile>> = Object.freeze({
  // A: always-on adaptive thinking (`disabled` is a 400).
  'claude-fable-5-1': { thinking: ALWAYS_ON, effort: EFFORT_ALL, prefixCheck: true },
  'claude-opus-5-5': { thinking: ALWAYS_ON, effort: EFFORT_ALL, prefixCheck: true },
  'claude-sonnet-5-5': { thinking: ALWAYS_ON, effort: EFFORT_ALL, prefixCheck: true },
  // Mythos 5.1 and every model before Fable 5.1 do not run the prefix check (S22).
  'claude-mythos-5-1': { thinking: ALWAYS_ON, effort: EFFORT_ALL, prefixCheck: false },
  'claude-fable-5': { thinking: ALWAYS_ON, effort: EFFORT_ALL, prefixCheck: false },
  'claude-mythos-5': { thinking: ALWAYS_ON, effort: EFFORT_ALL, prefixCheck: false },
  'claude-mythos-preview': { thinking: { adaptive: true, enabled: true, disabled: false }, effort: EFFORT_TO_MAX, prefixCheck: false },
  // B: switchable (adaptive, and `disabled` is accepted).
  'claude-haiku-5-5': { thinking: SWITCHABLE, effort: EFFORT_ALL, prefixCheck: true },
  'claude-opus-5': { thinking: SWITCHABLE, effort: EFFORT_ALL, prefixCheck: false },
  'claude-sonnet-5': { thinking: SWITCHABLE, effort: EFFORT_ALL, prefixCheck: false },
  'claude-opus-4-8': { thinking: SWITCHABLE, effort: EFFORT_ALL, prefixCheck: false },
  'claude-opus-4-7': { thinking: SWITCHABLE, effort: EFFORT_ALL, prefixCheck: false },
  'claude-opus-4-6': { thinking: SWITCHABLE_WITH_EXTENDED, effort: EFFORT_TO_MAX, prefixCheck: false },
  'claude-sonnet-4-6': { thinking: SWITCHABLE_WITH_EXTENDED, effort: EFFORT_TO_MAX, prefixCheck: false },
  // C: extended-only (`adaptive` is a 400). Opus 4.5 also takes effort (low to high).
  'claude-opus-4-5': { thinking: EXTENDED_ONLY, effort: EFFORT_NO_MAX, prefixCheck: false },
  'claude-sonnet-4-5': { thinking: EXTENDED_ONLY, effort: EFFORT_NONE, prefixCheck: false },
  'claude-haiku-4-5': { thinking: EXTENDED_ONLY, effort: EFFORT_NONE, prefixCheck: false },
});

/** The id without a trailing snapshot date (`claude-haiku-4-5-20251001` → `claude-haiku-4-5`). */
export function knownProfileId(id: string): string {
  return id.replace(/-\d{8}$/, '');
}

/** The table row for an id, or undefined. Own keys only: an id such as `constructor` is never a table hit. */
function lookupKnownProfile(id: string): KnownProfile | undefined {
  const key = knownProfileId(id);
  return Object.prototype.hasOwnProperty.call(KNOWN_PROFILES, key) ? KNOWN_PROFILES[key] : undefined;
}

export interface AnthropicProfileDisagreement {
  /** `thinking.adaptive`, `effort.max`, … */
  readonly form: string;
  readonly capabilities: boolean;
  readonly table: boolean;
}

/** What BotBoy may send to one model: `capabilities` AND the known table (when the id is in it). */
export interface AnthropicEffectiveProfile {
  readonly id: string;
  readonly kind: AnthropicProfileKind;
  readonly thinkingOff: AnthropicThinkingOff;
  readonly thinking: AnthropicThinkingForms;
  readonly effort: AnthropicEffortLevels;
  /** Only adaptive models in the known table's prefix-check set, and unknown adaptive ids. */
  readonly prefixCheck: boolean;
  readonly known: boolean;
  readonly disagreements: readonly AnthropicProfileDisagreement[];
}

const THINKING_OFF: Record<AnthropicProfileKind, AnthropicThinkingOff> = {
  A: 'lowest_effort',
  B: 'native_without_tools',
  C: 'native',
  D: 'unavailable',
};

/**
 * Derive the profile (D2 table): A always-on (adaptive, no `disabled`),
 * B switchable (adaptive and `disabled`), C extended-only (`enabled`, no
 * adaptive), D none or unknown. For an id in `KNOWN_PROFILES` a form counts
 * only when `capabilities` AND the table allow it (the stricter shape);
 * disagreements are reported, never resolved toward the looser side.
 */
export function deriveProfile(profile: AnthropicModelProfile): AnthropicEffectiveProfile {
  const known = lookupKnownProfile(profile.id);
  const disagreements: AnthropicProfileDisagreement[] = [];
  const combine = <T extends object>(group: string, caps: T, table: T | undefined): T => {
    if (!table) return caps;
    const out: Record<string, boolean> = {};
    for (const form of Object.keys(caps) as (keyof T & string)[]) {
      const fromCaps = Boolean(caps[form]);
      const fromTable = Boolean(table[form]);
      if (fromCaps !== fromTable) disagreements.push({ form: `${group}.${form}`, capabilities: fromCaps, table: fromTable });
      out[form] = fromCaps && fromTable;
    }
    return out as unknown as T;
  };
  const thinking = combine('thinking', profile.thinking, known?.thinking);
  const effort = combine('effort', profile.effort, known?.effort);
  const kind: AnthropicProfileKind = thinking.adaptive
    ? (thinking.disabled ? 'B' : 'A')
    : thinking.enabled ? 'C' : 'D';
  const adaptive = kind === 'A' || kind === 'B';
  return {
    id: profile.id,
    kind,
    thinkingOff: THINKING_OFF[kind],
    thinking,
    effort,
    prefixCheck: adaptive && (known ? known.prefixCheck : true),
    known: Boolean(known),
    disagreements,
  };
}

const loggedDisagreements = new Set<string>();

/** One warning per model id per process when `capabilities` and the known table disagree. */
export function logProfileDisagreementsOnce(effective: AnthropicEffectiveProfile): void {
  if (!effective.disagreements.length || loggedDisagreements.has(effective.id)) return;
  loggedDisagreements.add(effective.id);
  const detail = effective.disagreements
    .map(entry => `${entry.form} (capabilities ${entry.capabilities ? 'allow' : 'refuse'}, table ${entry.table ? 'allows' : 'refuses'})`)
    .join('; ');
  console.warn(`[Anthropic] Model ${effective.id}: capabilities and the known-model table disagree on ${detail}. BotBoy sends the stricter shape.`);
}

/** Test seam: forget which ids were already logged. */
export function resetProfileDisagreementLog(): void {
  loggedDisagreements.clear();
}

// ── Shaping thinking and effort (D2, D5) ──

/** Thinking tokens count toward `max_tokens` (S3), so the request leaves room for them. */
export const THINKING_ALLOWANCE: Readonly<Record<'low' | 'high' | 'max', number>> = Object.freeze({ low: 2_048, high: 8_192, max: 24_576 });
/** Off still thinks a little on profile A and on profile B with tools. */
export const THINKING_OFF_ALLOWANCE = 2_048;
const MIN_EXTENDED_BUDGET = 1_024;

export type AnthropicEffortValue = 'low' | 'medium' | 'high' | 'max';

export type AnthropicThinkingParam =
  | { readonly type: 'adaptive'; readonly display: 'summarized' | 'omitted' }
  | { readonly type: 'disabled' }
  | { readonly type: 'enabled'; readonly budget_tokens: number };

export interface AnthropicShapeInput {
  readonly level: LlmThinkingLevel;
  /** Whether the wire request carries `tools` (after the withheld-tools rule, L1). */
  readonly tools: boolean;
  /** The caller's `max_tokens` before the thinking allowance. */
  readonly maxTokens: number;
  /** Adaptive models only: 'summarized' for interactive streaming with thinking on, else 'omitted' (default). */
  readonly display?: 'summarized' | 'omitted';
}

export interface AnthropicThinkingShape {
  /** Omitted = send no `thinking` field. */
  readonly thinking?: AnthropicThinkingParam;
  /** `output_config.effort`; omitted = send none. `xhigh` is never sent. */
  readonly effort?: AnthropicEffortValue;
  /** The final `max_tokens`: min(model max, requested + allowance). */
  readonly maxTokens: number;
  /** Headroom added above the requested tokens for thinking (less than the nominal allowance when the model maximum clamps it). */
  readonly allowance: number;
}

const EFFORT_FALLBACK: readonly AnthropicEffortValue[] = ['max', 'high', 'medium', 'low'];

/** The requested level, or the nearest lower one the model supports (`max` → `high` on Opus 4.5). */
function pickEffort(effort: AnthropicEffortLevels, wanted: AnthropicEffortValue): AnthropicEffortValue | undefined {
  for (let index = EFFORT_FALLBACK.indexOf(wanted); index < EFFORT_FALLBACK.length; index += 1) {
    if (effort[EFFORT_FALLBACK[index]]) return EFFORT_FALLBACK[index];
  }
  return undefined;
}

/**
 * The `thinking` field, `output_config.effort` and `max_tokens` for one call
 * (D2 table). Never yields a form the model refuses: omission is valid on
 * every model, and profile B never sends effort next to `disabled`.
 */
export function shapeThinking(profile: AnthropicModelProfile, input: AnthropicShapeInput): AnthropicThinkingShape {
  const effective = deriveProfile(profile);
  const requested = Number.isFinite(input.maxTokens) && input.maxTokens > 0 ? Math.floor(input.maxTokens) : 1;
  const clamp = (allowance: number) => Math.max(1, Math.min(profile.maxOutputTokens, requested + allowance));
  // The allowance reported is the headroom actually added: the model's maximum can leave less than asked for.
  const finish = (shape: Omit<AnthropicThinkingShape, 'allowance'>): AnthropicThinkingShape =>
    ({ ...shape, allowance: Math.max(0, shape.maxTokens - requested) });
  const display = input.display ?? 'omitted';
  const level = input.level;

  if (effective.kind === 'D') return finish({ maxTokens: clamp(0) });

  if (effective.kind === 'C') {
    if (level === 'off') return finish({ maxTokens: clamp(0) });
    const maxTokens = clamp(THINKING_ALLOWANCE[level]);
    // Thinking gets what remains above the requested answer room; a manual budget is at least 1,024 and
    // below max_tokens (S20). Too little room: no thinking, rather than squeezing the answer.
    const budget = Math.min(THINKING_ALLOWANCE[level], maxTokens - requested);
    if (budget < MIN_EXTENDED_BUDGET) return finish({ maxTokens: clamp(0) });
    const effort = pickEffort(effective.effort, level);
    return finish({ thinking: { type: 'enabled', budget_tokens: budget }, ...(effort ? { effort } : {}), maxTokens });
  }

  // A and B: adaptive models.
  if (level === 'off') {
    if (effective.kind === 'B' && !input.tools) {
      // Native off; effort is never sent next to `disabled` (a 400 at xhigh/max on Opus 5 and Haiku 5.5).
      return finish({ thinking: { type: 'disabled' }, maxTokens: clamp(0) });
    }
    // Always-on models, and switchable ones with tools (Opus 5 can leak tool calls into text when thinking
    // is disabled on tool-heavy work): omit `thinking` and use the lowest effort.
    const effort = pickEffort(effective.effort, 'low');
    return finish({ ...(effort ? { effort } : {}), maxTokens: clamp(THINKING_OFF_ALLOWANCE) });
  }
  const effort = pickEffort(effective.effort, level);
  return finish({
    thinking: { type: 'adaptive', display },
    ...(effort ? { effort } : {}),
    maxTokens: clamp(THINKING_ALLOWANCE[level]),
  });
}

// ── Parsing a model list (D2, D8) ──

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 100_000_000 ? Number(value) : fallback;
}

function displayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 80) : undefined;
}

function leaf(group: any, ...path: string[]): boolean {
  let node = group;
  for (const key of path) node = node && typeof node === 'object' ? node[key] : undefined;
  return node?.supported === true;
}

function lifecycleOf(value: unknown): AnthropicLifecycle {
  return value === 'deprecated' || value === 'retired' ? value : 'active';
}

function rfc3339(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
}

/** One `ModelInfo` row (S6). Rows without a valid id are skipped (undefined). */
export function parseAnthropicModel(row: unknown): AnthropicModelProfile | undefined {
  const data = row as Record<string, any> | null;
  const id = typeof data?.id === 'string' ? data.id.trim() : '';
  if (!data || !MODEL_ID_PATTERN.test(id)) return undefined;
  const capabilities = data.capabilities && typeof data.capabilities === 'object' && !Array.isArray(data.capabilities) ? data.capabilities : null;
  const thinkingOn = capabilities ? leaf(capabilities, 'thinking') : false;
  const effortOn = capabilities ? leaf(capabilities, 'effort') : false;
  const imageSupport = capabilities?.image_input?.supported;
  const maxOutput = positiveInteger(data.max_tokens, UNKNOWN_MAX_OUTPUT_TOKENS);
  return {
    id,
    name: displayName(data.display_name) ?? id,
    line: typeof data.line === 'string' && LINE_PATTERN.test(data.line) ? data.line : null,
    lifecycle: lifecycleOf(data.lifecycle),
    retiresAt: rfc3339(data.retires_at),
    contextWindow: positiveInteger(data.max_input_tokens, UNKNOWN_CONTEXT_WINDOW),
    // Unknown capabilities: the output cap stays at the conservative 16,384.
    maxOutputTokens: capabilities ? maxOutput : Math.min(maxOutput, UNKNOWN_MAX_OUTPUT_TOKENS),
    ...(typeof imageSupport === 'boolean' ? { images: imageSupport } : {}),
    structuredOutputs: capabilities ? leaf(capabilities, 'structured_outputs') : false,
    thinking: {
      adaptive: thinkingOn && leaf(capabilities, 'thinking', 'types', 'adaptive'),
      enabled: thinkingOn && leaf(capabilities, 'thinking', 'types', 'enabled'),
      disabled: thinkingOn && leaf(capabilities, 'thinking', 'types', 'disabled'),
    },
    effort: {
      low: effortOn && leaf(capabilities, 'effort', 'low'),
      medium: effortOn && leaf(capabilities, 'effort', 'medium'),
      high: effortOn && leaf(capabilities, 'effort', 'high'),
      xhigh: effortOn && leaf(capabilities, 'effort', 'xhigh'),
      max: effortOn && leaf(capabilities, 'effort', 'max'),
    },
  };
}

export interface AnthropicModelPage {
  readonly models: AnthropicModelProfile[];
  /** The rows exactly as received, one per entry of `models`, in the same order. */
  readonly rawRows: unknown[];
  readonly hasMore: boolean;
  readonly lastId: string | null;
}

/** One `GET /v1/models` body. Throws when `data` is not an array (the caller maps it to an unreadable-list error). */
export function parseAnthropicModelPage(body: unknown): AnthropicModelPage {
  const page = body as { data?: unknown; has_more?: unknown; last_id?: unknown } | null;
  if (!page || !Array.isArray(page.data)) throw new Error('unreadable model list');
  const models: AnthropicModelProfile[] = [];
  const rawRows: unknown[] = [];
  for (const row of page.data.slice(0, ANTHROPIC_MODEL_PAGE_LIMIT)) {
    const model = parseAnthropicModel(row);
    if (!model) continue;
    models.push(model);
    rawRows.push(row);
  }
  return {
    models,
    rawRows,
    hasMore: page.has_more === true,
    lastId: typeof page.last_id === 'string' && MODEL_ID_PATTERN.test(page.last_id) ? page.last_id : null,
  };
}

/** A stored profile list (`keys.anthropic.models`); invalid rows are skipped, ids are unique. */
export function parseStoredAnthropicModels(value: unknown): AnthropicModelProfile[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const profiles: AnthropicModelProfile[] = [];
  for (const row of value.slice(0, ANTHROPIC_MAX_STORED_MODELS)) {
    const id = typeof row?.id === 'string' ? row.id.trim() : '';
    if (!MODEL_ID_PATTERN.test(id) || seen.has(id)) continue;
    const flags = (group: any, names: readonly string[]) => Object.fromEntries(names.map(name => [name, group?.[name] === true]));
    seen.add(id);
    profiles.push({
      id,
      name: displayName(row.name) ?? id,
      line: typeof row.line === 'string' && LINE_PATTERN.test(row.line) ? row.line : null,
      lifecycle: lifecycleOf(row.lifecycle),
      retiresAt: rfc3339(row.retiresAt),
      contextWindow: positiveInteger(row.contextWindow, UNKNOWN_CONTEXT_WINDOW),
      maxOutputTokens: positiveInteger(row.maxOutputTokens, UNKNOWN_MAX_OUTPUT_TOKENS),
      ...(typeof row.images === 'boolean' ? { images: row.images } : {}),
      structuredOutputs: row.structuredOutputs === true,
      thinking: flags(row.thinking, ['adaptive', 'enabled', 'disabled']) as unknown as AnthropicThinkingForms,
      effort: flags(row.effort, ['low', 'medium', 'high', 'xhigh', 'max']) as unknown as AnthropicEffortLevels,
    });
  }
  return profiles;
}

// ── What the key offers (D8) ──

/**
 * Offer `active` models; keep a `deprecated` one only when the key's previous
 * list or a role choice holds it (`keep`); never `retired`. The 100-model cap
 * applies after the lifecycle filter, in list order (newest first).
 */
export function selectOfferedModels(
  listed: readonly AnthropicModelProfile[],
  keep: ReadonlySet<string> = new Set(),
): AnthropicModelProfile[] {
  return listed
    .filter(model => model.lifecycle === 'active' || (model.lifecycle === 'deprecated' && keep.has(model.id)))
    .slice(0, ANTHROPIC_MAX_STORED_MODELS);
}

const DEFAULT_LINES: readonly string[] = ['sonnet', 'opus', 'haiku'];

const readsImagesAndSchemas = (model: AnthropicModelProfile) =>
  model.lifecycle === 'active' && model.images === true && model.structuredOutputs;

/**
 * Connection default (verification, Document writing, and chat): the newest
 * active Sonnet-line model with image input and structured outputs, else Opus,
 * else Haiku, else the first listed active model (list order is newest first).
 */
export function pickAnthropicDefaultModel(models: readonly AnthropicModelProfile[]): string | undefined {
  for (const line of DEFAULT_LINES) {
    const hit = models.find(model => model.line === line && readsImagesAndSchemas(model));
    if (hit) return hit.id;
  }
  return models.find(model => model.lifecycle === 'active')?.id;
}

/** Organizing default: the newest active Haiku-line model with both, else the connection default. */
export function pickAnthropicProcessingModel(models: readonly AnthropicModelProfile[]): string | undefined {
  return models.find(model => model.line === 'haiku' && readsImagesAndSchemas(model))?.id
    ?? pickAnthropicDefaultModel(models);
}

/** Models Save-time verification may try, in order (at most 3): the default pick first. */
export function anthropicVerificationCandidates(models: readonly AnthropicModelProfile[]): string[] {
  const active = models.filter(model => model.lifecycle === 'active');
  const lineRank = (model: AnthropicModelProfile) => {
    const index = DEFAULT_LINES.indexOf(model.line ?? '');
    return index === -1 ? DEFAULT_LINES.length : index;
  };
  // Array.prototype.sort is stable, so list order (newest first) holds within a line.
  const eligible = active.filter(readsImagesAndSchemas).sort((a, b) => lineRank(a) - lineRank(b));
  const first = pickAnthropicDefaultModel(models);
  return [...new Set([...(first ? [first] : []), ...eligible.map(model => model.id), ...active.map(model => model.id)])]
    .slice(0, ANTHROPIC_VERIFY_CANDIDATES);
}

// ── Talking to the API: list pages and Save-time verification (D8, D10) ──

interface ApiCall {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly fetchImpl: typeof fetch;
  readonly authStyle?: AnthropicAuthStyle;
}

function baseUrl(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

async function send(call: ApiCall, url: string, init: RequestInit, timeoutMs: number): Promise<{ response: Response; text: string }> {
  let response: Response;
  try {
    response = await call.fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    // Never forward the transport error: its text can carry the URL or headers.
    throw new AnthropicUnreachableError();
  }
  return { response, text: await response.text().catch(() => '') };
}

/** An unreadable 2xx body: reported like a 502 so Settings answers "try again". */
function unreadable(response: Response): AnthropicApiError {
  return new AnthropicApiError(classifyAnthropicHttpError(502, response.headers, ''));
}

export interface AnthropicModelListResult {
  /** Every model the key listed (first pages only, at most 5), in list order, before any lifecycle filter. */
  readonly models: AnthropicModelProfile[];
  /** The rows exactly as received (same bounds as `models`, duplicates removed by id), for the probe's list capture. */
  readonly rawRows: unknown[];
  readonly pages: number;
  /** true when the 5-page bound stopped paging while more models remained. */
  readonly truncated: boolean;
}

/** `GET /v1/models?limit=1000`, following `has_more` / `last_id` → `after_id`, at most 5 pages. */
export async function listAnthropicModels(call: ApiCall & {
  /** Timeout of each page request. */
  timeoutMs?: number;
  /** One deadline for the whole listing, however many pages it takes (boot uses this so five slow pages cannot hold startup for 25 s). */
  overallTimeoutMs?: number;
}): Promise<AnthropicModelListResult> {
  const models: AnthropicModelProfile[] = [];
  const rawRows: unknown[] = [];
  const seen = new Set<string>();
  const started = Date.now();
  let afterId: string | null = null;
  let pages = 0;
  let truncated = false;
  while (pages < ANTHROPIC_MAX_MODEL_PAGES) {
    const remaining = call.overallTimeoutMs === undefined ? Infinity : call.overallTimeoutMs - (Date.now() - started);
    if (remaining <= 0) throw new AnthropicUnreachableError();
    const query = `limit=${ANTHROPIC_MODEL_PAGE_LIMIT}${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ''}`;
    const { response, text } = await send(call, `${baseUrl(call.endpoint)}/v1/models?${query}`, {
      headers: anthropicRequestHeaders(call.apiKey, { style: call.authStyle }),
    }, Math.min(call.timeoutMs ?? LIST_TIMEOUT_MS, remaining));
    if (!response.ok) throw new AnthropicApiError(classifyAnthropicHttpError(response.status, response.headers, text, 'models'));
    let page: AnthropicModelPage;
    try {
      page = parseAnthropicModelPage(JSON.parse(text));
    } catch {
      throw unreadable(response);
    }
    pages += 1;
    // First occurrence of each id wins; raw rows stay in step with the parsed models.
    page.models.forEach((model, index) => {
      if (seen.has(model.id)) return;
      seen.add(model.id);
      models.push(model);
      rawRows.push(page.rawRows[index]);
    });
    if (!page.hasMore || !page.lastId || page.lastId === afterId) break;
    if (pages >= ANTHROPIC_MAX_MODEL_PAGES) truncated = true;
    afterId = page.lastId;
  }
  return { models, rawRows, pages, truncated };
}

export interface AnthropicVerification {
  /** Everything the key listed (≤5 pages) before the lifecycle filter. */
  readonly listed: readonly AnthropicModelProfile[];
  /** What the key offers: lifecycle filter, then the 100-model cap. */
  readonly models: readonly AnthropicModelProfile[];
  /** The model the minimal request succeeded on; null when the key lists no active model. */
  readonly verifiedModel: string | null;
}

/**
 * Save-time verification (D10): the model list (free), then ONE minimal
 * `POST /v1/messages` on the connection default with exactly
 * `{model, max_tokens: 16, messages:[{role:'user', content:'ping'}]}`: no
 * `thinking`, `output_config`, `tools` or `system`, so "the key works" never
 * depends on request shaping (omission is valid on every model). A `max_tokens`
 * stop still proves auth, access and credit. A 403 or 404 on that model tries
 * the next default-pick candidate (at most 3 in all); the last answer is then
 * the error. Any other failure ends verification at once.
 */
export async function verifyKey(call: ApiCall & {
  /** Deprecated models to keep offering (the key's previous list, role choices). */
  keep?: ReadonlySet<string>;
  listTimeoutMs?: number;
  messageTimeoutMs?: number;
}): Promise<AnthropicVerification> {
  const { models: listed } = await listAnthropicModels({ ...call, timeoutMs: call.listTimeoutMs });
  const models = selectOfferedModels(listed, call.keep);
  const candidates = anthropicVerificationCandidates(models);
  let failure: unknown;
  for (const model of candidates) {
    try {
      await verifyOnModel(call, model);
      return { listed, models, verifiedModel: model };
    } catch (error) {
      failure = error;
      const kind = isAnthropicApiError(error) ? error.classification.kind : undefined;
      if (kind !== 'forbidden' && kind !== 'model_unavailable') throw error;
    }
  }
  if (failure) throw failure;
  return { listed, models, verifiedModel: null };
}

async function verifyOnModel(call: ApiCall & { messageTimeoutMs?: number }, model: string): Promise<void> {
  const { response, text } = await send(call, `${baseUrl(call.endpoint)}/v1/messages`, {
    method: 'POST',
    headers: anthropicRequestHeaders(call.apiKey, { style: call.authStyle, json: true }),
    body: JSON.stringify({ model, max_tokens: ANTHROPIC_VERIFY_MAX_TOKENS, messages: [{ role: 'user', content: 'ping' }] }),
  }, call.messageTimeoutMs ?? VERIFY_TIMEOUT_MS);
  if (!response.ok) throw new AnthropicApiError(classifyAnthropicHttpError(response.status, response.headers, text));
  let answer: any;
  try {
    answer = JSON.parse(text);
  } catch {
    throw unreadable(response);
  }
  // A captive portal or proxy can answer 200 with something else: only a Message proves the key works.
  if (answer?.type !== 'message') throw unreadable(response);
}
