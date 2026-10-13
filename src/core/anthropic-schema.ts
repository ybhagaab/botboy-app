/**
 * Anthropic schema adaptation (design v3 D3 "Tools", D4, section 4 audit).
 *
 * Pure and I/O-free. Three jobs, each with one owner here:
 *
 *   1. `toAnthropicInputSchema`: a tool's `parameters` become a tool
 *      `input_schema` the Messages API cannot reject for its shape. The API
 *      reference documents only `type`, `properties` and `required` for
 *      `input_schema`, and one rejected tool fails the whole request, so a
 *      top-level `oneOf|anyOf|allOf|not` is removed by construction (its
 *      properties are hoisted and its shapes are described in one line).
 *      Nested keywords are forwarded as they are; probe P4 confirms them live.
 *   2. `adaptSchemaForAnthropic`: BotBoy's strict structured-output schema
 *      (closed objects, every property required) is made to fit the grammar
 *      subset Anthropic accepts: numeric and array bounds it cannot enforce
 *      are removed and written into the field's description; what cannot be
 *      adapted is refused locally, before any network call. The caller's own
 *      validator stays authoritative for every stripped bound.
 *   3. The JSON-mode shim: Anthropic has no `json_object` mode, so the
 *      instruction rides in `system` and one outer markdown fence is removed
 *      from the answer when the rest parses as an object.
 */

const COMBINATORS = ['oneOf', 'anyOf', 'allOf', 'not'] as const;
/** Alternatives (as opposed to `allOf`, which adds requirements): only these are described to the model. */
const ALTERNATIVES = ['oneOf', 'anyOf'] as const;
const MAX_SHAPES_LINE_CHARS = 800;

/** A schema BotBoy sends cannot be adapted for Anthropic; thrown before any request. */
export class AnthropicSchemaError extends Error {
  readonly code = 'ANTHROPIC_SCHEMA_UNSUPPORTED';
  constructor(message: string, readonly nextAction = 'Simplify the response schema (closed objects, every property required, no optional fields beyond 24) or pick another model.') {
    super(message);
    this.name = 'AnthropicSchemaError';
  }
}

export function isAnthropicSchemaError(error: unknown): error is AnthropicSchemaError {
  return error instanceof AnthropicSchemaError || (error as { code?: unknown } | null)?.code === 'ANTHROPIC_SCHEMA_UNSUPPORTED';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// ── 1. Tool input schemas (D3) ──

/** The single-valued property of one branch (`enum` of one value, or `const`): the branch's name. */
function discriminatorOf(branch: Record<string, unknown>): { key: string; value: string } | undefined {
  const properties = branch.properties;
  if (!isPlainObject(properties)) return undefined;
  for (const [key, definition] of Object.entries(properties)) {
    if (!isPlainObject(definition)) continue;
    if (Array.isArray(definition.enum) && definition.enum.length === 1 && definition.enum[0] !== null && typeof definition.enum[0] !== 'object') {
      return { key, value: String(definition.enum[0]) };
    }
    if ('const' in definition && definition.const !== null && typeof definition.const !== 'object') {
      return { key, value: String(definition.const) };
    }
  }
  return undefined;
}

/** "inspect_local_file(file); derive_semantic_hashes(metric, regime); …" from a list of alternative branches. */
function describeShapes(branches: readonly unknown[]): string {
  const shapes = branches.map((branch, index) => {
    const record = isPlainObject(branch) ? branch : {};
    const discriminator = discriminatorOf(record);
    const required = Array.isArray(record.required)
      ? record.required.filter((name): name is string => typeof name === 'string' && name !== discriminator?.key)
      : [];
    return `${discriminator?.value ?? `option ${index + 1}`}(${required.join(', ')})`;
  });
  const line = `Valid argument shapes: ${shapes.join('; ')}`;
  return line.length > MAX_SHAPES_LINE_CHARS ? `${line.slice(0, MAX_SHAPES_LINE_CHARS - 1)}…` : line;
}

/**
 * A tool's `parameters` as an Anthropic `input_schema`:
 *   (a) remove top-level `oneOf|anyOf|allOf|not`;
 *   (b) hoist any property a removed branch declares and the top level lacks
 *       (first definition wins; never added to `required`);
 *   (c) append one line to `description` built from the alternatives, using each
 *       branch's single-valued discriminator (`enum`/`const`, else `option N`) and
 *       its `required` minus that discriminator;
 *   (d) force `type: 'object'`. Nested combinators are forwarded unchanged.
 * Never mutates its input.
 */
export function toAnthropicInputSchema(parameters: Record<string, unknown>): Record<string, unknown> {
  const source = isPlainObject(parameters) ? parameters : {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if ((COMBINATORS as readonly string[]).includes(key)) continue;
    out[key] = key === 'properties' && isPlainObject(value) ? { ...value } : value;
  }
  out.type = 'object';

  const properties = isPlainObject(out.properties) ? (out.properties as Record<string, unknown>) : undefined;
  const hoisted: Record<string, unknown> = properties ?? {};
  let hoistedAny = false;
  for (const combinator of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branches = source[combinator];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (!isPlainObject(branch) || !isPlainObject(branch.properties)) continue;
      for (const [name, definition] of Object.entries(branch.properties)) {
        if (!Object.prototype.hasOwnProperty.call(hoisted, name)) {
          hoisted[name] = definition;
          hoistedAny = true;
        }
      }
    }
  }
  if (properties || hoistedAny) out.properties = hoisted;

  const lines: string[] = [];
  for (const combinator of ALTERNATIVES) {
    const branches = source[combinator];
    if (Array.isArray(branches) && branches.length > 0) lines.push(describeShapes(branches));
  }
  if (lines.length > 0) {
    const existing = typeof out.description === 'string' ? out.description.trim() : '';
    out.description = [existing, ...lines].filter(Boolean).join('\n');
  }
  return out;
}

// ── 2. Structured output schemas (D4) ──

/** Keywords BotBoy's strict contract allows (see `validateStrictJsonSchema`), plus those this adapter strips. */
const ALLOWED_KEYWORDS: ReadonlySet<string> = new Set([
  'type', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'description',
  'minimum', 'maximum', 'minItems', 'maxItems',
]);
const MAX_OPTIONAL_PROPERTIES = 24;
const MAX_UNION_PROPERTIES = 16;

export type StrippedKeyword = 'minimum' | 'maximum' | 'minItems' | 'maxItems';

export interface StrippedBound {
  /** `$.properties.evidence` style path of the schema node that carried the keyword. */
  readonly path: string;
  readonly keyword: StrippedKeyword;
  readonly value: number;
}

export interface AdaptedSchema {
  readonly schema: Record<string, unknown>;
  /** Every bound removed from the wire schema; the caller's validator must enforce each one. */
  readonly stripped: readonly StrippedBound[];
  /** Schema nodes typed as a union (a `type` array such as `['string','null']`). */
  readonly unionProperties: number;
  /** Properties not listed in `required` (BotBoy's strict contract guarantees 0). */
  readonly optionalProperties: number;
}

const STRIP_ORDER: readonly StrippedKeyword[] = ['minimum', 'maximum', 'minItems', 'maxItems'];

/**
 * Adapt a strict BotBoy JSON Schema to the subset Anthropic's `output_config.format` accepts (D4):
 * `minimum` and `maximum` are removed, `maxItems` is removed, `minItems` greater than 1 is removed
 * (0 and 1 are supported); each removed bound is appended to the node's `description`. Throws
 * `AnthropicSchemaError` (no network) for what cannot be adapted: an unknown keyword, an object that
 * is not closed (`additionalProperties: false`), more than 24 optional properties, more than 16
 * union-typed properties.
 */
export function adaptSchemaForAnthropic(schema: Record<string, unknown>): AdaptedSchema {
  if (!isPlainObject(schema)) throw new AnthropicSchemaError('The response schema must be a JSON object.');
  const stripped: StrippedBound[] = [];
  let unionProperties = 0;
  let optionalProperties = 0;

  const visit = (node: unknown, path: string): Record<string, unknown> => {
    if (!isPlainObject(node)) throw new AnthropicSchemaError(`The response schema node ${path} must be an object.`);
    for (const key of Object.keys(node)) {
      if (!ALLOWED_KEYWORDS.has(key)) throw new AnthropicSchemaError(`The response schema uses "${key}" at ${path}, which Anthropic structured output cannot take.`);
    }
    const out: Record<string, unknown> = {};
    const removed: string[] = [];
    for (const keyword of STRIP_ORDER) {
      const value = node[keyword];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new AnthropicSchemaError(`The response schema bound ${keyword} at ${path} is not a number.`);
      // minItems 0 and 1 are supported by the grammar; everything else here is not.
      if (keyword === 'minItems' && (value === 0 || value === 1)) continue;
      removed.push(`${keyword}: ${value}`);
      stripped.push({ path, keyword, value });
    }
    if (Array.isArray(node.type)) unionProperties += 1;

    for (const [key, value] of Object.entries(node)) {
      if (key === 'minimum' || key === 'maximum' || key === 'maxItems') continue;
      if (key === 'minItems' && !(value === 0 || value === 1)) continue;
      if (key === 'properties') {
        if (!isPlainObject(value)) throw new AnthropicSchemaError(`The response schema properties at ${path} must be an object.`);
        const adapted: Record<string, unknown> = {};
        for (const [name, child] of Object.entries(value)) adapted[name] = visit(child, `${path}.properties.${name}`);
        out.properties = adapted;
        continue;
      }
      if (key === 'items') {
        out.items = visit(value, `${path}.items`);
        continue;
      }
      out[key] = Array.isArray(value) ? [...value] : value;
    }

    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes('object')) {
      if (node.additionalProperties !== false) {
        throw new AnthropicSchemaError(`The response schema object at ${path} must set additionalProperties to false.`);
      }
      const properties = isPlainObject(node.properties) ? node.properties : {};
      const required = new Set(Array.isArray(node.required) ? node.required.filter((name): name is string => typeof name === 'string') : []);
      optionalProperties += Object.keys(properties).filter(name => !required.has(name)).length;
    }

    if (removed.length > 0) {
      const existing = typeof node.description === 'string' ? node.description.trim() : '';
      out.description = `${existing}${existing ? ' ' : ''}(${removed.join(', ')})`;
    }
    return out;
  };

  const adapted = visit(schema, '$');
  if (optionalProperties > MAX_OPTIONAL_PROPERTIES) {
    throw new AnthropicSchemaError(`The response schema has ${optionalProperties} optional properties; Anthropic accepts at most ${MAX_OPTIONAL_PROPERTIES}.`);
  }
  if (unionProperties > MAX_UNION_PROPERTIES) {
    throw new AnthropicSchemaError(`The response schema has ${unionProperties} union-typed properties; Anthropic accepts at most ${MAX_UNION_PROPERTIES}.`);
  }
  return { schema: adapted, stripped, unionProperties, optionalProperties };
}

// ── 3. JSON mode shim (D4) ──

export const JSON_MODE_INSTRUCTION = 'Return exactly one JSON object, no markdown fences, no commentary.';

/** `system` with the JSON-mode instruction appended as its own paragraph. */
export function withJsonModeInstruction(system: string | undefined): string {
  const base = (system ?? '').trim();
  return base ? `${base}\n\n${JSON_MODE_INSTRUCTION}` : JSON_MODE_INSTRUCTION;
}

/**
 * Prompt-only structured output, used when a model does not list `structured_outputs` (or its
 * capabilities are unknown): the schema itself rides in `system`. Not enforced by the API, so the
 * caller's validator is the only guard.
 */
export function withSchemaPromptInstruction(system: string | undefined, schema: Record<string, unknown>): string {
  const base = (system ?? '').trim();
  const instruction = `${JSON_MODE_INSTRUCTION} The object must conform to this JSON Schema: ${JSON.stringify(schema)}`;
  return base ? `${base}\n\n${instruction}` : instruction;
}

const OUTER_FENCE = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

function parsesAsObject(text: string): boolean {
  try {
    const value = JSON.parse(text);
    return isPlainObject(value);
  } catch {
    return false;
  }
}

/**
 * Remove ONE outer markdown fence when what is inside parses as a JSON object; anything else is
 * returned unchanged (callers parse and validate it, and a refusal stays visible as text).
 */
export function normalizeJsonModeText(text: string): string {
  const match = OUTER_FENCE.exec(text.trim());
  if (!match) return text;
  const inner = match[1].trim();
  return parsesAsObject(inner) ? inner : text;
}
