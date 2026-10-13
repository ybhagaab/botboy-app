import { describe, expect, it } from 'vitest';
import {
  AnthropicSchemaError,
  JSON_MODE_INSTRUCTION,
  adaptSchemaForAnthropic,
  isAnthropicSchemaError,
  normalizeJsonModeText,
  toAnthropicInputSchema,
  withJsonModeInstruction,
  withSchemaPromptInstruction,
} from './anthropic-schema.js';
import { createPromptManager } from './prompt-manager.js';
import { ANALYTICS_JOB_PLAN_RESPONSE_FORMAT } from './analytics-job-planner.js';
import { ANALYTICS_IMPORT_PROPOSAL_RESPONSE_FORMAT } from './analytics-import-semantic-proposal.js';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('toAnthropicInputSchema (design D3 Tools)', () => {
  const chatTools = (ctx: { amazonEmployee: boolean; driveConnected?: boolean }) =>
    createPromptManager().getToolDefinitions('chat', ctx);

  for (const amazonEmployee of [true, false]) {
    it(`removes the one top-level oneOf of create_data_room_dataset and keeps its four shapes readable (Amazon Employee ${amazonEmployee ? 'on' : 'off'})`, () => {
      const definition = chatTools({ amazonEmployee }).find(tool => tool.function.name === 'create_data_room_dataset')!;
      const parameters = deepFreeze(clone(definition.function.parameters)) as Record<string, any>;
      expect(Array.isArray(parameters.oneOf)).toBe(true);

      const schema = toAnthropicInputSchema(parameters) as Record<string, any>;
      expect(schema.type).toBe('object');
      for (const key of ['oneOf', 'anyOf', 'allOf', 'not']) expect(schema).not.toHaveProperty(key);
      expect(schema.additionalProperties).toBe(parameters.additionalProperties);
      expect(schema.required).toEqual(parameters.required);
      // The branches only declare `action`, which the top level already has, so nothing is hoisted.
      expect(Object.keys(schema.properties)).toEqual(Object.keys(parameters.properties));
      expect(schema.description.startsWith(parameters.description)).toBe(true);
      expect(schema.description.split('\n').at(-1)).toBe(
        'Valid argument shapes: inspect_local_file(file); derive_semantic_hashes(metric, regime); create(plan, ownerRequested); status(jobId)',
      );
      // Nested combinators are forwarded unchanged (confirmed live by probe P4, not assumed).
      expect(schema.properties.plan).toEqual(parameters.properties.plan);
      expect(JSON.stringify(schema.properties)).toContain('"oneOf"');
    });
  }

  it('does not touch a schema that has no top-level combinator, except forcing type object', () => {
    const parameters = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false, description: 'plain' };
    expect(toAnthropicInputSchema(parameters)).toEqual(parameters);
    expect(toAnthropicInputSchema({ properties: { a: { type: 'string' } } })).toEqual({ type: 'object', properties: { a: { type: 'string' } } });
    expect(toAnthropicInputSchema({})).toEqual({ type: 'object' });
  });

  it('hoists a property only a removed branch declares (first definition wins, never into required)', () => {
    const parameters = deepFreeze({
      type: 'object',
      properties: { mode: { type: 'string' } },
      required: ['mode'],
      anyOf: [
        { properties: { mode: { type: 'integer' }, extra: { type: 'string' } }, required: ['extra'] },
        { properties: { extra: { type: 'number' }, other: { type: 'boolean' } } },
      ],
    });
    const schema = toAnthropicInputSchema(parameters) as Record<string, any>;
    expect(schema).not.toHaveProperty('anyOf');
    expect(schema.properties).toEqual({ mode: { type: 'string' }, extra: { type: 'string' }, other: { type: 'boolean' } });
    expect(schema.required).toEqual(['mode']);
    expect(schema.description).toBe('Valid argument shapes: option 1(extra); option 2()');
  });

  it('names a branch by its single-valued enum or const, else option N, and lists its required fields minus the discriminator', () => {
    const schema = toAnthropicInputSchema({
      type: 'object',
      description: 'Pick a form.',
      properties: { kind: { type: 'string' } },
      oneOf: [
        { properties: { kind: { const: 'a' } }, required: ['kind', 'x'] },
        { properties: { kind: { enum: ['b'] } }, required: ['y', 'z'] },
        { properties: { kind: { enum: ['c', 'd'] } }, required: ['w'] },
        { required: ['v'] },
      ],
    }) as Record<string, any>;
    expect(schema.description).toBe('Pick a form.\nValid argument shapes: a(x); b(y, z); option 3(w); option 4(v)');
  });

  it('removes allOf and not at the top level too, hoisting properties without describing them as alternatives', () => {
    const schema = toAnthropicInputSchema({
      type: 'object',
      properties: {},
      allOf: [{ properties: { a: { type: 'string' } } }],
      not: { required: ['a'] },
    }) as Record<string, any>;
    expect(schema).not.toHaveProperty('allOf');
    expect(schema).not.toHaveProperty('not');
    expect(schema.properties).toEqual({ a: { type: 'string' } });
    expect(schema).not.toHaveProperty('description');
  });

  it('never mutates its input', () => {
    const parameters = deepFreeze(clone(chatTools({ amazonEmployee: true }).find(tool => tool.function.name === 'create_data_room_dataset')!.function.parameters));
    expect(() => toAnthropicInputSchema(parameters)).not.toThrow();
  });

  for (const ctx of [
    { amazonEmployee: true, driveConnected: false },
    { amazonEmployee: false, driveConnected: false },
    { amazonEmployee: true, driveConnected: true },
    { amazonEmployee: false, driveConnected: true },
  ]) {
    it(`gives every chat tool a valid name and a combinator-free object schema (Amazon Employee ${ctx.amazonEmployee ? 'on' : 'off'}, Drive ${ctx.driveConnected ? 'on' : 'off'})`, () => {
      const definitions = chatTools(ctx);
      expect(definitions.length).toBeGreaterThan(80);
      const names = definitions.map(tool => tool.function.name);
      expect(new Set(names).size).toBe(names.length);
      for (const definition of definitions) {
        expect(definition.function.name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
        const schema = toAnthropicInputSchema(definition.function.parameters) as Record<string, unknown>;
        expect(schema.type).toBe('object');
        for (const key of ['oneOf', 'anyOf', 'allOf', 'not']) expect(schema).not.toHaveProperty(key);
      }
    });
  }
});

describe('adaptSchemaForAnthropic (design D4)', () => {
  const planner = ANALYTICS_JOB_PLAN_RESPONSE_FORMAT as { schema: Record<string, any> };
  const proposal = ANALYTICS_IMPORT_PROPOSAL_RESPONSE_FORMAT as { schema: Record<string, any> };

  it('leaves the planner envelope schema exactly as it is (0 optional, 0 unions, no bounds)', () => {
    const result = adaptSchemaForAnthropic(planner.schema);
    expect(result.schema).toEqual(planner.schema);
    expect(result.stripped).toEqual([]);
    expect(result.unionProperties).toBe(0);
    expect(result.optionalProperties).toBe(0);
  });

  it('adapts the import proposal schema to an exact expected output: 8 bounds removed and written into descriptions, 5 unions kept', () => {
    const original = deepFreeze(clone(proposal.schema));
    const result = adaptSchemaForAnthropic(original);
    expect(result.stripped).toEqual([
      { path: '$.properties.headerRow', keyword: 'minimum', value: 1 },
      { path: '$.properties.dataStartRow', keyword: 'minimum', value: 1 },
      { path: '$.properties.dataEndRow', keyword: 'minimum', value: 1 },
      { path: '$.properties.wideHeadings.items.properties.row', keyword: 'minimum', value: 1 },
      { path: '$.properties.evidence', keyword: 'minItems', value: 21 },
      { path: '$.properties.evidence', keyword: 'maxItems', value: 21 },
      { path: '$.properties.evidence.items.properties.confidence', keyword: 'minimum', value: 0 },
      { path: '$.properties.evidence.items.properties.confidence', keyword: 'maximum', value: 1 },
    ]);
    expect(result.unionProperties).toBe(5);
    expect(result.optionalProperties).toBe(0);

    const adapted = result.schema as Record<string, any>;
    expect(adapted.properties.headerRow).toEqual({ type: 'integer', description: '(minimum: 1)' });
    expect(adapted.properties.evidence.description).toBe('(minItems: 21, maxItems: 21)');
    expect(adapted.properties.evidence).not.toHaveProperty('minItems');
    expect(adapted.properties.evidence).not.toHaveProperty('maxItems');
    expect(adapted.properties.evidence.items.properties.confidence).toEqual({ type: 'number', description: '(minimum: 0, maximum: 1)' });
    expect(adapted.properties.timeColumn).toEqual({ type: ['string', 'null'] });
    expect(adapted.properties.status).toEqual({ type: 'string', enum: ['ready', 'needs_input'] });
    // Everything the adapter does not own is untouched: same required lists, same closed objects.
    expect(adapted.required).toEqual(original.required);
    expect(adapted.additionalProperties).toBe(false);
    expect(adapted.properties.evidence.items.required).toEqual(original.properties.evidence.items.required);

    // The exact expected output: the original with only the documented edits applied.
    const expected = clone(proposal.schema);
    for (const name of ['headerRow', 'dataStartRow', 'dataEndRow']) {
      delete expected.properties[name].minimum;
      expected.properties[name].description = '(minimum: 1)';
    }
    delete expected.properties.wideHeadings.items.properties.row.minimum;
    expected.properties.wideHeadings.items.properties.row.description = '(minimum: 1)';
    delete expected.properties.evidence.minItems;
    delete expected.properties.evidence.maxItems;
    expected.properties.evidence.description = '(minItems: 21, maxItems: 21)';
    const confidence = expected.properties.evidence.items.properties.confidence;
    delete confidence.minimum;
    delete confidence.maximum;
    confidence.description = '(minimum: 0, maximum: 1)';
    expect(adapted).toEqual(expected);
    // No removed bound survives anywhere.
    expect(JSON.stringify(adapted)).not.toMatch(/"(minimum|maximum|maxItems|minItems)"/);
  });

  it('never mutates the schema it is given', () => {
    expect(() => adaptSchemaForAnthropic(deepFreeze(clone(proposal.schema)))).not.toThrow();
  });

  it('keeps minItems of 0 or 1, which the grammar supports, and strips the rest', () => {
    const result = adaptSchemaForAnthropic({
      type: 'object',
      additionalProperties: false,
      required: ['a', 'b', 'c'],
      properties: {
        a: { type: 'array', items: { type: 'string' }, minItems: 1 },
        b: { type: 'array', items: { type: 'string' }, minItems: 0 },
        c: { type: 'array', items: { type: 'string' }, minItems: 2, description: 'Items.' },
      },
    });
    const properties = result.schema.properties as Record<string, any>;
    expect(properties.a.minItems).toBe(1);
    expect(properties.b.minItems).toBe(0);
    expect(properties.c).toEqual({ type: 'array', items: { type: 'string' }, description: 'Items. (minItems: 2)' });
    expect(result.stripped).toEqual([{ path: '$.properties.c', keyword: 'minItems', value: 2 }]);
  });

  it('refuses locally what it cannot adapt', () => {
    const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
      ({ type: 'object', additionalProperties: false, required, properties });
    const refused: Array<[string, unknown]> = [
      ['a non-object root', []],
      ['an open object', { type: 'object', required: [], properties: {} }],
      ['an unknown keyword', closed({ a: { type: 'string', pattern: '^a' } })],
      ['a combinator', closed({ a: { oneOf: [{ type: 'string' }] } })],
      ['a non-numeric bound', closed({ a: { type: 'integer', minimum: 'one' } })],
      ['a nested open object', closed({ a: { type: 'object', properties: {}, required: [] } })],
    ];
    for (const [label, schema] of refused) {
      expect(() => adaptSchemaForAnthropic(schema as Record<string, unknown>), label).toThrow(AnthropicSchemaError);
    }
    const many = (count: number, extra: Record<string, unknown> = {}) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`p${index}`, { type: 'string', ...extra }]));
    // 24 optional properties are allowed, 25 are not.
    expect(() => adaptSchemaForAnthropic(closed(many(24), []))).not.toThrow();
    expect(() => adaptSchemaForAnthropic(closed(many(25), []))).toThrow(/optional properties/);
    // 16 union-typed properties are allowed, 17 are not.
    const unions = (count: number) => Object.fromEntries(Object.keys(many(count)).map(name => [name, { type: ['string', 'null'] }]));
    expect(() => adaptSchemaForAnthropic(closed(unions(16)))).not.toThrow();
    expect(() => adaptSchemaForAnthropic(closed(unions(17)))).toThrow(/union-typed/);
    try {
      adaptSchemaForAnthropic([] as unknown as Record<string, unknown>);
    } catch (error) {
      expect(isAnthropicSchemaError(error)).toBe(true);
      expect((error as AnthropicSchemaError).nextAction).toMatch(/Simplify/);
    }
  });
});

describe('JSON-mode shim (design D4)', () => {
  it('appends the instruction to system as its own paragraph', () => {
    expect(withJsonModeInstruction('You classify items.')).toBe(`You classify items.\n\n${JSON_MODE_INSTRUCTION}`);
    expect(withJsonModeInstruction('')).toBe(JSON_MODE_INSTRUCTION);
    expect(withJsonModeInstruction(undefined)).toBe(JSON_MODE_INSTRUCTION);
    expect(JSON_MODE_INSTRUCTION).toBe('Return exactly one JSON object, no markdown fences, no commentary.');
  });

  it('puts the schema in the prompt when the model cannot enforce one', () => {
    const text = withSchemaPromptInstruction('Base.', { type: 'object', properties: { a: { type: 'string' } } });
    expect(text.startsWith(`Base.\n\n${JSON_MODE_INSTRUCTION} The object must conform to this JSON Schema: {"type":"object"`)).toBe(true);
  });

  it('removes one outer fence only when the inside parses as a JSON object', () => {
    expect(normalizeJsonModeText('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(normalizeJsonModeText('```\n{"a":{"b":[1,2]}}\n```')).toBe('{"a":{"b":[1,2]}}');
    expect(normalizeJsonModeText('  ```JSON\r\n{"a":1}\r\n```  ')).toBe('{"a":1}');
    // Already plain, an array, not JSON, or text around the fence: returned unchanged.
    expect(normalizeJsonModeText('{"a":1}')).toBe('{"a":1}');
    expect(normalizeJsonModeText('```json\n[1,2]\n```')).toBe('```json\n[1,2]\n```');
    expect(normalizeJsonModeText('```json\nnot json\n```')).toBe('```json\nnot json\n```');
    expect(normalizeJsonModeText('Here you go:\n```json\n{"a":1}\n```')).toBe('Here you go:\n```json\n{"a":1}\n```');
    expect(normalizeJsonModeText("I can't help with that.")).toBe("I can't help with that.");
    // Only the outermost fence goes; a fence inside a string value stays.
    expect(normalizeJsonModeText('```json\n{"code":"```js\\nx\\n```"}\n```')).toBe('{"code":"```js\\nx\\n```"}');
  });
});
