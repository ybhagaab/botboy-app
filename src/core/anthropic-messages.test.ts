import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LlmMessage, StreamChunk, ToolCall, ToolDefinition } from './llm-client.js';
import {
  AnthropicHistoryError,
  EAGER_INPUT_TOOLS,
  buildAnthropicBody,
  canonicalJson,
  convertHistory,
  createAnthropicStreamReducer,
  createSseFrameParser,
  imageBlockFromDataUrl,
  isAnthropicHistoryError,
  mapAnthropicUsage,
  mapStopReason,
  measureAnthropicRequest,
  resolveWireTools,
  sanitizeToolId,
  thinkingLevelOf,
  toAnthropicTools,
  toLlmUsage,
  unknownAnthropicProfile,
  type AnthropicBlock,
  type AnthropicTool,
  type BuildBodyInput,
  type ToolsMemory,
} from './anthropic-messages.js';
import { AnthropicApiError } from './anthropic-errors.js';
import { parseAnthropicModel, type AnthropicModelProfile } from './anthropic-models.js';
import { fakeModelRow, validateFakeMessagesBody, type FakeModelSpec } from './anthropic-api.fake.js';
import { createPromptManager } from './prompt-manager.js';

/**
 * Design v3 D2 / D3 / D5 / D6 / D7 / D8 (slice A2): the pure half of the Claude transport, with no network.
 * Wire shapes are checked against the fake server's own capability validator, so a body that passes here is
 * one the modelled API accepts for that model.
 */
const user = (content: string, extra: Partial<LlmMessage> = {}): LlmMessage => ({ role: 'user', content, ...extra });
const assistant = (content: string | null, extra: Record<string, unknown> = {}): LlmMessage => ({ role: 'assistant', content, ...extra } as LlmMessage);
const call = (id: string, name: string, args: unknown): ToolCall => ({
  id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});
const toolRow = (id: string, content: string): LlmMessage => ({ role: 'tool', content, toolCallId: id });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const SPECS = {
  A: { id: 'claude-sonnet-5-5', variant: 'A', line: 'sonnet' },
  B: { id: 'claude-haiku-5-5', variant: 'B', line: 'haiku' },
  C: { id: 'claude-opus-4-5-20251101', variant: 'C', line: 'opus', effort: { low: true, medium: true, high: true }, maxInputTokens: 200_000, maxTokens: 64_000 },
  D: { id: 'claude-3-haiku-20240307', variant: 'D', line: 'haiku', maxInputTokens: 200_000, maxTokens: 4_096 },
} satisfies Record<string, FakeModelSpec>;
const profileOf = (spec: FakeModelSpec): AnthropicModelProfile => parseAnthropicModel(fakeModelRow(spec))!;

/** The minimal memory the withheld-tools rule needs (the real LRU lives in the replay guard). */
function memory(): ToolsMemory & { sets: AnthropicTool[][] } {
  const sets: AnthropicTool[][] = [];
  return {
    sets,
    remember: tools => { sets.push([...tools]); },
    resolveWithheld: names => {
      for (let index = sets.length - 1; index >= 0; index -= 1) {
        const have = new Set(sets[index].map(tool => tool.name));
        if (names.every(name => have.has(name))) return sets[index];
      }
      return names.map(name => ({ name, description: '(Unavailable in this step.)', input_schema: { type: 'object', properties: {} } }));
    },
  };
}

const toolDef = (name: string, extra: Record<string, unknown> = {}): ToolDefinition => ({
  type: 'function',
  function: { name, description: `${name} tool`, parameters: { type: 'object', properties: { path: { type: 'string' } }, ...extra } },
});

function bodyFor(
  spec: FakeModelSpec,
  messages: LlmMessage[],
  options: Partial<Omit<BuildBodyInput, 'profile' | 'history' | 'wireTools'>> & { tools?: ToolDefinition[]; history?: ReturnType<typeof convertHistory> } = {},
) {
  const profile = profileOf(spec);
  const history = options.history ?? convertHistory(messages, { contextWindow: profile.contextWindow });
  const wireTools = resolveWireTools(options.tools, history.toolNames, memory());
  return buildAnthropicBody({
    model: profile.id, profile, history, wireTools,
    level: 'off', maxTokens: 1_000, display: 'omitted', cache: false, stream: true,
    ...options,
  });
}

// ── History ──

describe('convertHistory (D3 history rules)', () => {
  it('joins every system row into the top-level system and keeps the messages list free of system turns', () => {
    const history = convertHistory([
      { role: 'system', content: 'You are BotBoy.' },
      user('hello'),
      { role: 'system', content: 'Extra rule.' },
    ]);
    expect(history.system).toBe('You are BotBoy.\n\nExtra rule.');
    expect(history.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  });

  it('prepends the fixed user line when the persisted window starts with an assistant row, and keeps strict alternation (20-row window)', () => {
    const rows: LlmMessage[] = Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0 ? assistant(`answer ${index}`) : user(`question ${index}`));
    const history = convertHistory(rows);
    expect(history.messages).toHaveLength(21);
    expect(history.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '(Earlier messages omitted.)' }] });
    history.messages.forEach((message, index) => expect(message.role).toBe(index % 2 === 0 ? 'user' : 'assistant'));
    expect(history.messages.at(-1)!.role).toBe('user');
    expect(history.notes.prependedLeadingUser).toBe(true);
  });

  it('drops an empty assistant row and merges the two user rows around it (a failed earlier turn)', () => {
    const history = convertHistory([user('first'), assistant(''), user('second')]);
    expect(history.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] }]);
    expect(history.notes.droppedEmptyRows).toBe(1);
    expect(history.notes.mergedRows).toBe(1);
  });

  it('drops whitespace-only rows and null content (text has minLength 1)', () => {
    const history = convertHistory([user('   \n'), assistant(null), user('real')]);
    expect(history.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'real' }] }]);
  });

  it('refuses an empty conversation and a conversation that ends with an assistant turn, naming the next action', () => {
    expect(() => convertHistory([])).toThrow(AnthropicHistoryError);
    expect(() => convertHistory([user('   ')])).toThrow(/nothing to send/);
    try {
      convertHistory([user('hi'), assistant('hello')]);
      throw new Error('should have thrown');
    } catch (error) {
      expect(isAnthropicHistoryError(error)).toBe(true);
      expect((error as AnthropicHistoryError).kind).toBe('history_ends_with_assistant');
      expect((error as AnthropicHistoryError).nextAction).toMatch(/Send a new message/);
    }
  });

  it('puts images before text and normalizes image/jpg', () => {
    const history = convertHistory([user('look', { images: [PNG, PNG.replace('image/png', 'image/jpg')] })]);
    const blocks = history.messages[0].content;
    expect(blocks.map(block => block.type)).toEqual(['image', 'image', 'text']);
    expect((blocks[0] as any).source).toMatchObject({ type: 'base64', media_type: 'image/png' });
    expect((blocks[1] as any).source.media_type).toBe('image/jpeg');
    expect(history.imageCount).toBe(2);
  });

  it('refuses unsupported image types and over-sized images with the fix, and caps images at 100 on a 200K window only', () => {
    expect(() => imageBlockFromDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toThrow(/JPEG, PNG, GIF and WebP/);
    expect(() => imageBlockFromDataUrl('data:image/png;base64,' + 'A'.repeat(10_000_001))).toThrow(/10 MB/);
    expect(() => imageBlockFromDataUrl('not a data url')).toThrow(AnthropicHistoryError);
    const many = [user('x', { images: Array.from({ length: 101 }, () => PNG) })];
    expect(() => convertHistory(many, { contextWindow: 200_000 })).toThrow(/at most 100/);
    expect(() => convertHistory(many, { contextWindow: 1_000_000 })).not.toThrow();
  });
});

describe('convertHistory: assistant turns and tool results', () => {
  const searchCall = call('call_1', 'read_file', { path: 'a.txt' });
  const listCall = call('call_2', 'list_files', { dir: '.' });

  it('builds text and tool_use blocks from the call list when there is no provider output, and pairs parallel results into ONE user message, results first, in call order', () => {
    const history = convertHistory([
      user('go'),
      assistant('on it', { tool_calls: [searchCall, listCall] }),
      toolRow('call_2', 'files...'),
      toolRow('call_1', 'contents...'),
      user('Browser screenshot evidence.', { images: [PNG] }),
    ]);
    expect(history.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [
        { type: 'text', text: 'on it' },
        { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
        { type: 'tool_use', id: 'call_2', name: 'list_files', input: { dir: '.' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'contents...' },
        { type: 'tool_result', tool_use_id: 'call_2', content: 'files...' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.split(',')[1] } },
        { type: 'text', text: 'Browser screenshot evidence.' },
      ] },
    ]);
    expect(history.toolNames).toEqual(['read_file', 'list_files']);
  });

  it('reads both camelCase and snake_case call and id fields', () => {
    const history = convertHistory([
      user('go'),
      assistant('', { toolCalls: [searchCall] }),
      { role: 'tool', content: 'ok', tool_call_id: 'call_1' } as unknown as LlmMessage,
    ]);
    expect(history.messages[1].content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }]);
    expect(history.messages[2].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' });
  });

  it('drops an orphan tool_result and the user message it leaves empty', () => {
    const history = convertHistory([user('a'), toolRow('call_zzz', 'stale'), user('b')]);
    expect(history.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]);
    expect(history.notes.droppedOrphanResults).toBe(1);
  });

  it('adds an is_error stub for a tool_use without a result, and a stub user turn when the history ends on one', () => {
    const history = convertHistory([user('go'), assistant('', { tool_calls: [searchCall, listCall] }), toolRow('call_1', 'only one')]);
    const results = history.messages.at(-1)!.content;
    expect(results[0]).toEqual({ type: 'tool_result', tool_use_id: 'call_1', content: 'only one' });
    expect(results[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_2', is_error: true });
    const trailing = convertHistory([user('go'), assistant('', { tool_calls: [searchCall] })]);
    expect(trailing.messages.at(-1)).toEqual({ role: 'user', content: [expect.objectContaining({ type: 'tool_result', tool_use_id: 'call_1', is_error: true })] });
    expect(trailing.notes.stubResults).toBe(1);
  });

  it('gives an empty tool result a visible placeholder and sanitizes ids the same way on both sides', () => {
    const odd = call('call.1|x', 'read_file', {});
    const history = convertHistory([user('go'), assistant('', { tool_calls: [odd] }), toolRow('call.1|x', '')]);
    const use = history.messages[1].content[0] as any;
    const result = history.messages[2].content[0] as any;
    expect(use.id).toBe('call_1_x');
    expect(result).toEqual({ type: 'tool_result', tool_use_id: 'call_1_x', content: '(empty result)' });
    expect(sanitizeToolId('')).toBe('toolu_unknown');
    expect(sanitizeToolId('toolu_01T1x1fJ34qAmk2tNTrN7Up6')).toBe('toolu_01T1x1fJ34qAmk2tNTrN7Up6');
  });

  it('drops a thinking-only assistant row (it has nothing to say) but keeps thinking next to real content', () => {
    const thinkingOnly = assistant('', { providerOutput: [{ type: 'thinking', thinking: 'hmm', signature: 'sig-1' }] });
    const history = convertHistory([user('a'), thinkingOnly, user('b')]);
    expect(history.messages).toHaveLength(1);
  });

  describe('replaying provider output', () => {
    const output: AnthropicBlock[] = [
      { type: 'thinking', thinking: '', signature: 'sig-empty-text' },
      { type: 'redacted_thinking', data: 'opaque-data' },
      { type: 'text', text: 'Reading it now.' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
    ];

    it('replays the response blocks verbatim and in order, empty-text thinking and redacted thinking included', () => {
      const history = convertHistory([user('go'), assistant('Reading it now.', { providerOutput: output, tool_calls: [searchCall] }), toolRow('call_1', 'ok')]);
      expect(history.messages[1].content).toEqual(output);
      expect(history.edited).toEqual([]);
    });

    it('drops a thinking block that has no signature (it would fail), and a redacted block with no data', () => {
      const history = convertHistory([
        user('go'),
        assistant('', { providerOutput: [
          { type: 'thinking', thinking: 'x', signature: '' },
          { type: 'redacted_thinking', data: '' },
          { type: 'text', text: 'answer' },
        ] }),
        user('next'),
      ]);
      expect(history.messages[1].content).toEqual([{ type: 'text', text: 'answer' }]);
    });

    it('substitutes tool_use input from the paired call (chat compacts write_file content) and marks that message edited', () => {
      const big = { path: 'a.html', content: 'x'.repeat(5_000) };
      const compact = { path: 'a.html', content: 'x'.repeat(300) + '... [TRUNCATED — 5000 chars written successfully, see tool result]' };
      const writeCall = call('call_w', 'write_file', compact);
      const history = convertHistory([
        user('write it'),
        assistant('', { providerOutput: [{ type: 'tool_use', id: 'call_w', name: 'write_file', input: big }], tool_calls: [writeCall] }),
        toolRow('call_w', 'written'),
      ]);
      expect((history.messages[1].content[0] as any).input).toEqual(compact);
      expect(history.edited).toEqual([1]);
    });

    it('does not mark a message edited when the arguments only differ in key order or spacing', () => {
      const same = call('call_1', 'read_file', '{ "path":"a.txt" }');
      const history = convertHistory([user('go'), assistant('', { providerOutput: output, tool_calls: [same] }), toolRow('call_1', 'ok')]);
      expect(history.edited).toEqual([]);
      expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
    });

    it('sends {} for unparseable arguments, marks the message edited and the matching result as an error', () => {
      const broken = call('call_1', 'write_file', '{"path":"a.html","content":"unterminated');
      const history = convertHistory([
        user('go'),
        assistant('', { providerOutput: [{ type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'a.html' } }], tool_calls: [broken] }),
        toolRow('call_1', 'Truncated tool args, not executing. Resend smaller.'),
      ]);
      expect((history.messages[1].content[0] as any).input).toEqual({});
      expect(history.edited).toEqual([1]);
      expect(history.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1', is_error: true });
      // An array or scalar is not an arguments object either.
      const array = convertHistory([user('go'), assistant('', { tool_calls: [call('call_9', 'read_file', '[1]')] }), toolRow('call_9', 'refused')]);
      expect((array.messages[1].content[0] as any).input).toEqual({});
    });
  });
});

// ── Tools ──

describe('toAnthropicTools and the withheld-tools rule (D3)', () => {
  it('maps a definition to name, description and a sanitized input_schema, in a stable byte order', () => {
    const definition = toolDef('read_file', { required: ['path'], oneOf: [{ required: ['path'] }] });
    const [tool] = toAnthropicTools([definition]);
    expect(Object.keys(tool)).toEqual(['name', 'description', 'input_schema']);
    expect(tool.name).toBe('read_file');
    expect(tool.input_schema).not.toHaveProperty('oneOf');
    expect(JSON.stringify(toAnthropicTools([definition]))).toBe(JSON.stringify(toAnthropicTools([definition])));
  });

  it('marks exactly write_file and save_product_document for eager input streaming', () => {
    const tools = createPromptManager().getToolDefinitions('chat', { amazonEmployee: true, driveConnected: true });
    const eager = toAnthropicTools(tools).filter(tool => tool.eager_input_streaming).map(tool => tool.name).sort();
    expect(eager).toEqual(['save_product_document', 'write_file']);
    expect([...EAGER_INPUT_TOOLS].sort()).toEqual(eager);
  });

  it('maps and remembers a real tool array, and re-sends the remembered one for undefined and [] while the history holds tool blocks', () => {
    const memo = memory();
    const real = resolveWireTools([toolDef('read_file'), toolDef('list_files')], [], memo);
    expect(real.withheld).toBe(false);
    expect(real.tools?.map(tool => tool.name)).toEqual(['read_file', 'list_files']);
    for (const requestTools of [undefined, []] as const) {
      const withheld = resolveWireTools(requestTools, ['read_file'], memo);
      expect(withheld.withheld).toBe(true);
      expect(withheld.tools).toEqual(real.tools);
    }
    // No tool blocks in the history: nothing is sent and nothing is withheld.
    expect(resolveWireTools([], [], memo)).toEqual({ withheld: false });
    // A preflight does not remember.
    const quiet = memory();
    resolveWireTools([toolDef('read_file')], [], quiet, { remember: false });
    expect(quiet.sets).toHaveLength(0);
  });
});

// ── Request body ──

describe('buildAnthropicBody (D2, D4, D5, D8)', () => {
  const conversation = [user('Summarize the project.')];
  const toolConversation = [
    user('go'),
    assistant('', { providerOutput: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: {} }], tool_calls: [call('call_1', 'read_file', {})] }),
    toolRow('call_1', 'ok'),
  ];

  it('never puts temperature, top_p, top_k, prefill or a forced tool choice on the wire', () => {
    for (const spec of Object.values(SPECS)) {
      for (const level of ['off', 'low', 'high', 'max'] as const) {
        const { body } = bodyFor(spec, toolConversation, { level, tools: [toolDef('read_file')] });
        const wire = JSON.parse(JSON.stringify(body));
        for (const field of ['temperature', 'top_p', 'top_k', 'prefill']) expect(wire).not.toHaveProperty(field);
        expect(wire.messages.at(-1).role).toBe('user');
        expect(wire.tool_choice).toBeUndefined();
      }
    }
  });

  for (const [kind, spec] of Object.entries(SPECS)) {
    it(`never sends a form the model refuses: profile ${kind}, every level, with and without tools (validated by the fake's own capability rules)`, () => {
      const row = fakeModelRow(spec);
      for (const level of ['off', 'low', 'high', 'max'] as const) {
        for (const withTools of [false, true]) {
          const { body } = bodyFor(spec, withTools ? toolConversation : conversation, { level, tools: withTools ? [toolDef('read_file')] : undefined });
          expect(validateFakeMessagesBody(row, body), `${kind} ${level} tools=${withTools}`).toBeUndefined();
          expect(body.max_tokens).toBeLessThanOrEqual((row as any).max_tokens);
        }
      }
    });
  }

  it('on a switchable model never sends disabled once tools are in the request, even when the caller withheld them (undefined and [])', () => {
    for (const requestTools of [undefined, []] as ToolDefinition[][] | undefined[]) {
      const memo = memory();
      resolveWireTools([toolDef('read_file')], [], memo);
      const profile = profileOf(SPECS.B);
      const history = convertHistory(toolConversation, { contextWindow: profile.contextWindow });
      const wireTools = resolveWireTools(requestTools as ToolDefinition[] | undefined, history.toolNames, memo);
      const { body } = buildAnthropicBody({ model: profile.id, profile, history, wireTools, level: 'off', maxTokens: 1_000, display: 'omitted', cache: false, stream: true });
      expect(body.tool_choice).toEqual({ type: 'none' });
      expect(body.tools?.map(tool => tool.name)).toEqual(['read_file']);
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toEqual({ effort: 'low' });
    }
    // Without tools anywhere, Off really disables thinking on the same model.
    expect(bodyFor(SPECS.B, conversation).body.thinking).toEqual({ type: 'disabled' });
  });

  it('uses summarized thinking only when the caller asks for it, and the adaptive form carries no budget', () => {
    expect(bodyFor(SPECS.A, conversation, { level: 'high', display: 'summarized' }).body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(bodyFor(SPECS.A, conversation, { level: 'high', display: 'omitted' }).body.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    expect(bodyFor(SPECS.C, conversation, { level: 'high' }).body.thinking).toMatchObject({ type: 'enabled' });
  });

  it('keeps one thinking mode through a tool turn on an extended-only model', () => {
    const withThinking = [
      user('go'),
      assistant('', { providerOutput: [
        { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
        { type: 'tool_use', id: 'call_1', name: 'read_file', input: {} },
      ], tool_calls: [call('call_1', 'read_file', {})] }),
      toolRow('call_1', 'ok'),
    ];
    expect(bodyFor(SPECS.C, withThinking, { level: 'high', tools: [toolDef('read_file')] }).body.thinking).toMatchObject({ type: 'enabled' });
    // The earlier assistant message of this turn has no thinking block: this request sends none.
    expect(bodyFor(SPECS.C, toolConversation, { level: 'high', tools: [toolDef('read_file')] }).body.thinking).toBeUndefined();
    // A new user turn starts afresh.
    const fresh = [...toolConversation, assistant('done'), user('another question')];
    expect(bodyFor(SPECS.C, fresh, { level: 'high' }).body.thinking).toMatchObject({ type: 'enabled' });
  });

  it('treats a model the list does not describe conservatively: no thinking, no effort, no schema, output at most 16,384', () => {
    const profile = unknownAnthropicProfile('claude-future-9');
    const history = convertHistory(conversation);
    const { body, responseMode } = buildAnthropicBody({
      model: profile.id, profile, history, wireTools: { withheld: false },
      level: 'max', maxTokens: 100_000, display: 'summarized', cache: false, stream: true,
      responseFormat: { type: 'json_schema', name: 'x', strict: true, schema: { type: 'object', additionalProperties: false, required: [], properties: {} } },
    });
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.max_tokens).toBe(16_384);
    expect(responseMode).toBe('schema_prompt');
    expect(body.system).toContain('Return exactly one JSON object');
  });

  it('adds the top-level cache marker only when asked and tools are sent', () => {
    expect(bodyFor(SPECS.A, conversation, { cache: true, tools: [toolDef('read_file')] }).body.cache_control).toEqual({ type: 'ephemeral' });
    expect(bodyFor(SPECS.A, conversation, { cache: true }).body.cache_control).toBeUndefined();
    expect(bodyFor(SPECS.A, conversation, { cache: false, tools: [toolDef('read_file')] }).body.cache_control).toBeUndefined();
  });

  it('maps the response format: json_object to a system instruction, a strict schema to output_config.format beside effort, else prompt-only', () => {
    const schema = { type: 'object', additionalProperties: false, required: ['n'], properties: { n: { type: 'integer', minimum: 1 } } };
    const jsonObject = bodyFor(SPECS.A, conversation, { responseFormat: { type: 'json_object' } });
    expect(jsonObject.responseMode).toBe('json_object');
    expect(jsonObject.body.system).toBe('Return exactly one JSON object, no markdown fences, no commentary.');
    expect(jsonObject.body.output_config?.format).toBeUndefined();

    const native = bodyFor(SPECS.A, conversation, { level: 'high', responseFormat: { type: 'json_schema', name: 'n', strict: true, schema } });
    expect(native.responseMode).toBe('schema_native');
    expect(native.strippedBounds).toBe(1);
    expect(native.body.output_config).toEqual({
      effort: 'high',
      format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false, required: ['n'], properties: { n: { type: 'integer', description: '(minimum: 1)' } } } },
    });
    expect(native.body.system).toBeUndefined();

    const noSchemas = bodyFor({ ...SPECS.A, structuredOutputs: false }, conversation, { responseFormat: { type: 'json_schema', name: 'n', strict: true, schema } });
    expect(noSchemas.responseMode).toBe('schema_prompt');
    expect(noSchemas.body.output_config?.format).toBeUndefined();
    expect(noSchemas.body.system).toContain('conform to this JSON Schema');
  });

  it('adds the documented block-binding control on adaptive thinking only', () => {
    const forced = bodyFor(SPECS.A, conversation, { level: 'high', binding: 'drop_block' }).body.thinking as any;
    expect(forced).toEqual({ type: 'adaptive', display: 'omitted', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect((bodyFor(SPECS.C, conversation, { level: 'high', binding: 'error' }).body.thinking as any).block_binding).toBeUndefined();
    expect(bodyFor(SPECS.A, conversation, { level: 'off', binding: 'error' }).body.thinking).toBeUndefined();
  });

  it('derives the thinking level from think and reasoningEffort', () => {
    expect(thinkingLevelOf({})).toBe('off');
    expect(thinkingLevelOf({ think: false, reasoningEffort: 'max' })).toBe('off');
    expect(thinkingLevelOf({ think: true })).toBe('low');
    expect(thinkingLevelOf({ think: true, reasoningEffort: 'max' })).toBe('max');
    expect(thinkingLevelOf({ think: true }, 'high')).toBe('high');
  });
});

describe('measureAnthropicRequest (D7)', () => {
  const imageBody = (...texts: string[]) => JSON.stringify(buildAnthropicBody({
    model: 'm', profile: unknownAnthropicProfile('m'),
    history: convertHistory([user('look', { images: [PNG, PNG] }), assistant('ok'), user('and then?'), ...texts.map(text => user(text))]),
    wireTools: { withheld: false }, level: 'off', maxTokens: 10, display: 'omitted', cache: false, stream: true,
  }).body);

  it('counts base64 image blocks, which providerRequestSize cannot see', () => {
    const size = measureAnthropicRequest(imageBody());
    expect(size.imageCount).toBe(2);
    expect(size.imageChars).toBe(2 * PNG.split(',')[1].length);
    expect(size.bodyChars).toBeGreaterThan(size.imageChars);
    expect(measureAnthropicRequest(JSON.stringify({ messages: [{ role: 'user', content: 'no images' }] })).imageCount).toBe(0);
  });

  it('is not fooled by text that quotes the marker (quotes inside text are escaped)', () => {
    const quoted = imageBody('"source":{"type":"base64","media_type":"image/png","data":"AAAA"}');
    expect(measureAnthropicRequest(quoted).imageCount).toBe(2);
  });
});

// ── Usage and stop reasons ──

describe('usage and stop reasons (D3)', () => {
  it('totals input as input + cache creation + cache read, keeps cache as a subset, and reads thinking tokens', () => {
    const parsed = mapAnthropicUsage({
      input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 300, output_tokens: 50,
      output_tokens_details: { thinking_tokens: 30 },
    });
    expect(parsed).toEqual({
      reported: true, inputTokens: 420, outputTokens: 50, totalTokens: 470,
      cacheReadTokens: 300, cacheWriteTokens: 20, reasoningTokens: 30,
    });
    expect(toLlmUsage(parsed)).toEqual({ promptTokens: 420, completionTokens: 50, totalTokens: 470, cacheReadTokens: 300, cacheWriteTokens: 20 });
  });

  it('keeps missing values null (never zero) and says nothing was reported when there is no usage object', () => {
    expect(mapAnthropicUsage({ output_tokens: 7 })).toMatchObject({ reported: true, inputTokens: null, outputTokens: 7, totalTokens: null, cacheReadTokens: null, reasoningTokens: null });
    expect(mapAnthropicUsage(undefined)).toMatchObject({ reported: false, inputTokens: null });
    expect(mapAnthropicUsage({ input_tokens: -1, output_tokens: 'x' })).toMatchObject({ inputTokens: null, outputTokens: null });
    expect(toLlmUsage(mapAnthropicUsage(undefined))).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it('maps every documented stop reason', () => {
    for (const reason of ['end_turn', 'stop_sequence', 'pause_turn', 'refusal', null, 'something_new']) expect(mapStopReason(reason, false)).toBe('stop');
    expect(mapStopReason('tool_use', true)).toBe('tool_calls');
    expect(mapStopReason('tool_use', false)).toBe('stop');
    expect(mapStopReason('max_tokens', false)).toBe('length');
    expect(mapStopReason('model_context_window_exceeded', true)).toBe('length');
  });
});

// ── SSE ──

const sample = (name: string) => fs.readFileSync(new URL(`./testdata/anthropic-sse/${name}`, import.meta.url), 'utf8');

function reduce(sse: string, options: { toolsOffered?: boolean; normalizeJson?: boolean; chunkSize?: number } = {}) {
  const reducer = createAnthropicStreamReducer({ toolsOffered: options.toolsOffered ?? true, normalizeJson: options.normalizeJson });
  const parser = createSseFrameParser();
  const chunks: StreamChunk[] = [];
  const size = options.chunkSize ?? sse.length;
  const feed = (frames: ReturnType<typeof parser.push>) => {
    for (const frame of frames) chunks.push(...reducer.push(JSON.parse(frame.data)));
  };
  for (let index = 0; index < sse.length; index += size) feed(parser.push(sse.slice(index, index + size)));
  feed(parser.flush());
  return { reducer, chunks };
}

describe('createSseFrameParser', () => {
  it('parses frames split anywhere, CRLF streams, comments, multi-line data and a missing final blank line', () => {
    const text = 'event: a\r\ndata: {"n":1}\r\n\r\n: keepalive\n\nevent: b\ndata: line1\ndata: line2\n\ndata: {"n":3}';
    for (const size of [1, 2, 3, 7, 1000]) {
      const parser = createSseFrameParser();
      const frames = [];
      for (let index = 0; index < text.length; index += size) frames.push(...parser.push(text.slice(index, index + size)));
      frames.push(...parser.flush());
      expect(frames, `chunk size ${size}`).toEqual([
        { event: 'a', data: '{"n":1}' },
        { event: 'b', data: 'line1\nline2' },
        { event: null, data: '{"n":3}' },
      ]);
    }
  });

  it('dispatches on a new event line when the stream has no blank separators', () => {
    const parser = createSseFrameParser();
    const frames = [...parser.push('event: ping\ndata: {"type":"ping"}\nevent: message_stop\ndata: {"type":"message_stop"}\n'), ...parser.flush()];
    expect(frames.map(frame => frame.event)).toEqual(['ping', 'message_stop']);
  });
});

describe('createAnthropicStreamReducer on the documentation samples (D6)', () => {
  it('reduces the basic stream: text deltas, cumulative usage from message_start then message_delta', () => {
    const { reducer, chunks } = reduce(sample('basic.sse'));
    const outcome = reducer.finish();
    expect(chunks).toEqual([{ type: 'content', text: 'Hello' }, { type: 'content', text: '!' }]);
    expect(outcome.content).toBe('Hello!');
    expect(outcome.finishReason).toBe('stop');
    expect(outcome.stopReason).toBe('end_turn');
    expect(outcome.usage).toMatchObject({ reported: true, inputTokens: 25, outputTokens: 15, totalTokens: 40 });
    expect(outcome.providerOutput).toEqual([{ type: 'text', text: 'Hello!' }]);
    expect(outcome.messageId).toBe('msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY');
  });

  it('reduces the tool-use stream: the chunk index is the tool ordinal, the call keeps the streamed argument text, the replay block holds the parsed object', () => {
    const { reducer, chunks } = reduce(sample('tool-use.sse'), { chunkSize: 37 });
    const outcome = reducer.finish();
    expect(outcome.content).toBe("Okay, let's check the weather for San Francisco, CA:");
    const starts = chunks.filter(chunk => chunk.type === 'tool_call_start');
    expect(starts).toEqual([{ type: 'tool_call_start', toolCall: { index: 0, id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6', name: 'get_weather' } }]);
    const args = chunks.filter(chunk => chunk.type === 'tool_call_args').map(chunk => chunk.toolCall!.arguments).join('');
    expect(args).toBe('{"location": "San Francisco, CA"}');
    expect(chunks.filter(chunk => chunk.type === 'tool_call_args').every(chunk => chunk.toolCall!.index === 0)).toBe(true);
    expect(outcome.toolCalls).toEqual([{ id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6', type: 'function', function: { name: 'get_weather', arguments: '{"location": "San Francisco, CA"}' } }]);
    expect(outcome.providerOutput).toEqual([
      { type: 'text', text: "Okay, let's check the weather for San Francisco, CA:" },
      { type: 'tool_use', id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6', name: 'get_weather', input: { location: 'San Francisco, CA' } },
    ]);
    expect(outcome.finishReason).toBe('tool_calls');
    expect(outcome.usage).toMatchObject({ inputTokens: 472, outputTokens: 89 });
  });

  it('reduces the thinking stream: summarized text goes to the UI, the block keeps text and signature for replay, multi-byte text survives', () => {
    const { reducer, chunks } = reduce(sample('thinking.sse'), { chunkSize: 5 });
    const outcome = reducer.finish();
    const thinking = chunks.filter(chunk => chunk.type === 'thinking').map(chunk => chunk.text).join('');
    expect(thinking).toBe('I need to find the GCD of 1071 and 462 using the Euclidean algorithm.\n\n1071 = 2 × 462 + 147\n462 = 3 × 147 + 21\n147 = 7 × 21 + 0\nThe remainder is 0, so GCD(1071, 462) = 21.');
    expect(outcome.reasoning).toBe(thinking);
    expect(outcome.content).toBe('The greatest common divisor of 1071 and 462 is **21**.');
    expect(outcome.providerOutput[0]).toEqual({ type: 'thinking', thinking, signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds...' });
    expect(outcome.thinkingBlocks).toBe(1);
    // No usage anywhere in this sample: nothing is reported, never zeros.
    expect(outcome.usage.reported).toBe(false);
  });

  it('keeps an omitted-display thinking block (empty text, one signature) without forwarding empty deltas', () => {
    const events = [
      { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'blob' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9, output_tokens_details: { thinking_tokens: 5 } } },
      { type: 'message_stop' },
    ];
    const reducer = createAnthropicStreamReducer({ toolsOffered: false });
    const chunks = events.flatMap(event => reducer.push(event));
    expect(chunks).toEqual([]);
    const outcome = reducer.finish();
    expect(outcome.providerOutput).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig-abc' },
      { type: 'redacted_thinking', data: 'blob' },
    ]);
    expect(outcome.thinkingBlocks).toBe(2);
    expect(outcome.usage).toMatchObject({ inputTokens: 10, outputTokens: 9, reasoningTokens: 5 });
  });

  it('keeps the raw argument text when it does not parse (chat refuses it) and replays {}', () => {
    const events = [
      { type: 'message_start', message: { id: 'm' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'write_file', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.html","content":"<h1>' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
      { type: 'message_stop' },
    ];
    const reducer = createAnthropicStreamReducer({ toolsOffered: true });
    events.forEach(event => reducer.push(event));
    const outcome = reducer.finish();
    expect(outcome.toolCalls[0].function.arguments).toBe('{"path":"a.html","content":"<h1>');
    expect(outcome.providerOutput).toEqual([{ type: 'tool_use', id: 'toolu_a', name: 'write_file', input: {} }]);
    expect(outcome.finishReason).toBe('length');
  });

  it('numbers parallel tool calls by ordinal and ignores tool_use when the caller withheld tools', () => {
    const events = [
      { type: 'message_start', message: { id: 'm' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_a', name: 'a', input: {} } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_b', name: 'b', input: { x: 1 } } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];
    const offered = createAnthropicStreamReducer({ toolsOffered: true });
    const chunks = events.flatMap(event => offered.push(event));
    expect(chunks.filter(chunk => chunk.type === 'tool_call_start').map(chunk => chunk.toolCall!.index)).toEqual([0, 1]);
    const outcome = offered.finish();
    expect(outcome.toolCalls.map(entry => [entry.id, entry.function.arguments])).toEqual([['toolu_a', '{}'], ['toolu_b', '{"x":1}']]);

    const withheld = createAnthropicStreamReducer({ toolsOffered: false });
    events.forEach(event => withheld.push(event));
    const none = withheld.finish();
    expect(none.toolCalls).toEqual([]);
    expect(none.providerOutput).toEqual([]);
    expect(none.finishReason).toBe('stop');
  });

  it('turns an in-stream error event into the classified error with the status its type stands for', () => {
    const reducer = createAnthropicStreamReducer({ toolsOffered: true });
    let error: unknown;
    try {
      for (const frame of createSseFrameParser().push(sample('error-overloaded.sse'))) reducer.push(JSON.parse(frame.data));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AnthropicApiError);
    const classification = (error as AnthropicApiError).classification;
    expect(classification).toMatchObject({ status: 529, kind: 'overloaded', issue: 'overloaded' });
    expect((error as Error).message).toMatch(/^HTTP 529 \(overloaded_error\)/);
    // A type the API adds later counts as a server error, never a 4xx.
    expect(() => reducer.push({ type: 'error', error: { type: 'brand_new_error', message: 'x' } })).toThrow(/^HTTP 500/);
    expect(() => reducer.push({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } })).toThrow(/^HTTP 400/);
  });

  it('refuses a stream that ended without message_stop, and ignores events it does not know', () => {
    const reducer = createAnthropicStreamReducer({ toolsOffered: true });
    reducer.push({ type: 'message_start', message: { id: 'm' } });
    reducer.push({ type: 'a_future_event', anything: true });
    reducer.push({ type: 'ping' });
    expect(reducer.stopped).toBe(false);
    expect(() => reducer.finish()).toThrow(/terminated before message_stop/);
  });

  it('shows a note naming the category when Claude refuses with no text, and reads context-window stops as length', () => {
    const refusal = createAnthropicStreamReducer({ toolsOffered: true });
    refusal.push({ type: 'message_start', message: { id: 'm' } });
    refusal.push({ type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { category: 'reasoning_extraction' } } });
    refusal.push({ type: 'message_stop' });
    expect(refusal.finish().content).toBe('Claude declined to answer this request (reason: reasoning_extraction).');

    const full = createAnthropicStreamReducer({ toolsOffered: true });
    full.push({ type: 'message_delta', delta: { stop_reason: 'model_context_window_exceeded' } });
    full.push({ type: 'message_stop' });
    expect(full.finish().finishReason).toBe('length');
  });

  it('removes one outer fence from a JSON-mode answer when asked', () => {
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '```json\n{"a":1}\n```' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];
    const plain = createAnthropicStreamReducer({ toolsOffered: false });
    events.forEach(event => plain.push(event));
    expect(plain.finish().content).toBe('```json\n{"a":1}\n```');
    const normalized = createAnthropicStreamReducer({ toolsOffered: false, normalizeJson: true });
    events.forEach(event => normalized.push(event));
    expect(normalized.finish().content).toBe('{"a":1}');
  });
});
