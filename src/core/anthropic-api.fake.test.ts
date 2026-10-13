import { afterEach, describe, expect, it } from 'vitest';
import {
  FAKE_ANTHROPIC_KEY,
  FAKE_BINDING_BETA,
  FAKE_LATEST_RUN_400,
  FAKE_SIGNATURE_400,
  startFakeAnthropic,
  type FakeAnthropicOptions,
  type FakeAnthropicServer,
  type FakeMessageReply,
  type FakeModelSpec,
} from './anthropic-api.fake.js';
import { createAnthropicStreamReducer, createSseFrameParser } from './anthropic-messages.js';

/**
 * The fake server is test infrastructure for everything that sends a Messages request, so its own rules are
 * pinned here: what it refuses, which switches exist (the undocumented behaviors), how it replays thinking, and
 * how its SSE is shaped. Each case cites the documented behavior it models (design v3 section 6).
 */
const MODELS: FakeModelSpec[] = [
  { id: 'claude-sonnet-5-5', variant: 'A', line: 'sonnet' },
  { id: 'claude-haiku-5-5', variant: 'B', line: 'haiku' },
  { id: 'claude-opus-4-5-20251101', variant: 'C', line: 'opus', effort: { low: true, medium: true, high: true }, maxInputTokens: 200_000, maxTokens: 64_000 },
  { id: 'claude-opus-5-5', variant: 'A', line: 'opus' },
  { id: 'claude-no-schema', variant: 'A', line: 'sonnet', structuredOutputs: false },
];

let fake: FakeAnthropicServer | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });

async function start(options: FakeAnthropicOptions = {}) {
  fake = await startFakeAnthropic({ models: MODELS, ...options });
  return fake;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${fake!.url}${path}`, {
    method: 'POST',
    headers: { 'x-api-key': FAKE_ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, text, json, headers: response.headers };
}

const userText = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const base = (extra: Record<string, unknown> = {}) => ({ model: 'claude-sonnet-5-5', max_tokens: 100, messages: [userText('hi')], ...extra });
const errorMessage = (result: { json?: any }) => String(result.json?.error?.message ?? '');

function frames(text: string) {
  const parser = createSseFrameParser();
  return [...parser.push(text), ...parser.flush()].map(frame => ({ event: frame.event, data: JSON.parse(frame.data) }));
}

describe('fake Anthropic: replies', () => {
  it('answers a plain request with pong as JSON, and as the documented event flow when streaming', async () => {
    await start();
    const json = await post('/v1/messages', base());
    expect(json.status).toBe(200);
    expect(json.json).toMatchObject({ type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn' });
    expect(json.json.usage.input_tokens).toBeGreaterThan(0);

    const sse = await post('/v1/messages', base({ stream: true }));
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    const events = frames(sse.text);
    expect(events.map(event => event.data.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(events.every(event => event.event === event.data.type)).toBe(true);
    const reducer = createAnthropicStreamReducer({ toolsOffered: false });
    events.forEach(event => reducer.push(event.data));
    expect(reducer.finish().content).toBe('pong');
  });

  it('answers 404 for a retired or unknown model, and the scripted answer when the script returns an error', async () => {
    await start({ models: [...MODELS, { id: 'claude-gone', variant: 'A', lifecycle: 'retired' }] });
    expect((await post('/v1/messages', base({ model: 'claude-gone' }))).status).toBe(404);
    expect((await post('/v1/messages', base({ model: 'claude-nonexistent' }))).status).toBe(404);
    fake!.reply = () => ({ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } });
    expect((await post('/v1/messages', base())).status).toBe(529);
  });

  it('scripts blocks: generated signatures and ids, display omitted blanks the thinking text, tool input streams in chunks', async () => {
    await start();
    fake!.reply = () => ({
      content: [
        { type: 'thinking', thinking: 'a long private plan' },
        { type: 'redacted_thinking' },
        { type: 'text', text: 'Reading now.' },
        { type: 'tool_use', name: 'read_file', input: { path: 'a.txt', note: 'x'.repeat(60) } },
      ],
    });
    const shown = await post('/v1/messages', base({ thinking: { type: 'adaptive', display: 'summarized' } }));
    expect(shown.json.content[0]).toMatchObject({ type: 'thinking', thinking: 'a long private plan' });
    expect(shown.json.content[0].signature).toMatch(/^sig_fake_/);
    expect(shown.json.content[1].data).toMatch(/^redacted_fake_/);
    expect(shown.json.content[3]).toMatchObject({ type: 'tool_use', name: 'read_file' });
    expect(shown.json.stop_reason).toBe('tool_use');
    const omitted = await post('/v1/messages', base({ thinking: { type: 'adaptive', display: 'omitted' } }));
    expect(omitted.json.content[0].thinking).toBe('');
    expect(omitted.json.content[0].signature).toMatch(/^sig_fake_/);

    const streamed = frames((await post('/v1/messages', base({ stream: true }))).text);
    const deltas = streamed.filter(event => event.data.delta?.type === 'input_json_delta');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map(event => event.data.delta.partial_json).join('')).toBe(JSON.stringify({ path: 'a.txt', note: 'x'.repeat(60) }));
  });

  it('reports cumulative usage: message_start carries the input side, message_delta the output total', async () => {
    await start();
    fake!.reply = () => ({ content: [{ type: 'text', text: 'x'.repeat(400) }] });
    const events = frames((await post('/v1/messages', base({ stream: true }))).text);
    const start_ = events.find(event => event.data.type === 'message_start')!.data.message.usage;
    const delta = events.find(event => event.data.type === 'message_delta')!.data.usage;
    expect(start_.output_tokens).toBe(1);
    expect(delta.output_tokens).toBeGreaterThan(50);
    expect(start_.input_tokens).toBeGreaterThan(0);
  });

  it('models prompt caching: a repeated cache_control prefix is created once, then read', async () => {
    await start();
    const request = base({ cache_control: { type: 'ephemeral' }, system: 'You are BotBoy.', tools: [{ name: 'read_file', description: 'r', input_schema: { type: 'object' } }] });
    const first = await post('/v1/messages', request);
    const second = await post('/v1/messages', request);
    expect(first.json.usage.cache_creation_input_tokens).toBeGreaterThan(0);
    expect(first.json.usage.cache_read_input_tokens).toBe(0);
    expect(second.json.usage.cache_creation_input_tokens).toBe(0);
    expect(second.json.usage.cache_read_input_tokens).toBeGreaterThan(0);
    const uncached = await post('/v1/messages', base());
    expect(uncached.json.usage.cache_read_input_tokens).toBe(0);
    expect(uncached.json.usage.cache_creation_input_tokens).toBe(0);
  });
});

describe('fake Anthropic: SSE shapes the client must survive', () => {
  it('can send pings, end early with no message_stop, or send an error event', async () => {
    await start();
    fake!.reply = () => ({ stream: { pings: true } });
    expect(frames((await post('/v1/messages', base({ stream: true }))).text).filter(event => event.data.type === 'ping').length).toBeGreaterThan(0);
    fake!.reply = () => ({ stream: { truncateAfter: 3 } });
    const truncated = frames((await post('/v1/messages', base({ stream: true }))).text);
    expect(truncated).toHaveLength(3);
    expect(truncated.some(event => event.data.type === 'message_stop')).toBe(false);
    fake!.reply = () => ({ stream: { error: { type: 'overloaded_error', message: 'Overloaded', afterEvents: 2 } } });
    const failing = frames((await post('/v1/messages', base({ stream: true }))).text);
    expect(failing.at(-1)).toMatchObject({ event: 'error', data: { type: 'error', error: { type: 'overloaded_error' } } });
  });

  it('can reset the connection mid-stream: the client reads the first events and then its read FAILS, it does not end cleanly', async () => {
    await start();
    fake!.reply = () => ({ content: [{ type: 'text', text: 'x'.repeat(400) }], stream: { chunk: 20, resetAfter: 3 } });
    const response = await fetch(`${fake!.url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': FAKE_ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(base({ stream: true })),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let received = '';
    const read = async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return 'ended';
        received += Buffer.from(value).toString('utf8');
      }
    };
    await expect(read()).rejects.toBeInstanceOf(Error);
    expect(frames(received).length).toBeGreaterThanOrEqual(1);
    expect(received).not.toContain('message_stop');
  });

  it('is silent for a buffered tool and streams an eager one: the first input delta waits or does not', async () => {
    await start();
    const reply: FakeMessageReply = {
      content: [{ type: 'tool_use', name: 'write_file', input: { content: 'y'.repeat(100) } }],
      stream: { chunk: 30, toolInputDelayMs: 150, toolInputGapMs: 5 },
    };
    fake!.reply = () => reply;
    const timeToFirstDelta = async (eager: boolean) => {
      const began = Date.now();
      const response = await fetch(`${fake!.url}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': FAKE_ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(base({ stream: true, tools: [{ name: 'write_file', description: 'w', input_schema: { type: 'object' }, ...(eager ? { eager_input_streaming: true } : {}) }] })),
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes('input_json_delta')) { await reader.cancel(); return Date.now() - began; }
      }
      return Date.now() - began;
    };
    expect(await timeToFirstDelta(false)).toBeGreaterThanOrEqual(140);
    expect(await timeToFirstDelta(true)).toBeLessThan(140);
  });
});

describe('fake Anthropic: what it refuses (documented 400s)', () => {
  it('refuses sampling parameters on 5.x models only', async () => {
    await start();
    for (const field of ['temperature', 'top_p', 'top_k']) {
      expect(errorMessage(await post('/v1/messages', base({ [field]: 0.2 })))).toContain(`\`${field}\` is not supported`);
    }
    expect((await post('/v1/messages', base({ model: 'claude-opus-4-5-20251101', temperature: 0.2 }))).status).toBe(200);
  });

  it('refuses prefill, empty text, a tool_result that is not first, an unpaired tool_use, an orphan tool_result and a bad tool name', async () => {
    await start();
    const refused = async (messages: unknown[], match: RegExp, extra: Record<string, unknown> = {}) => {
      const result = await post('/v1/messages', base({ messages, ...extra }));
      expect(result.status, match.source).toBe(400);
      expect(errorMessage(result)).toMatch(match);
    };
    await refused([userText('hi'), { role: 'assistant', content: [{ type: 'text', text: 'partial' }] }], /prefill/);
    await refused([{ role: 'user', content: [{ type: 'text', text: '  ' }] }], /non-whitespace text/);
    await refused([userText('go'), { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }], /tool_result blocks must come first/);
    await refused([userText('go'), { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} }] }, userText('no result')], /without `tool_result` blocks/);
    await refused([userText('go'), { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_zzz', content: 'stale' }] }], /unexpected `tool_use_id`/);
    await refused([userText('go'), { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'bad name!', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }], /pattern/);
    await refused([{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'AAAA' } }] }], /JPEG, PNG, GIF and WebP/);
  });

  it('accepts a correct tool loop with the results first', async () => {
    await start();
    const result = await post('/v1/messages', base({
      messages: [
        userText('go'),
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }, { type: 'text', text: 'and continue' }] },
      ],
      tools: [{ name: 'read_file', description: 'r', input_schema: { type: 'object' } }],
    }));
    expect(result.status).toBe(200);
  });

  it('has a switch for a leading assistant message and for a top-level combinator, and refuses both by default', async () => {
    const leading = [{ role: 'assistant', content: [{ type: 'text', text: 'earlier' }] }, userText('now')];
    const combinator = { tools: [{ name: 'create', description: 'c', input_schema: { type: 'object', oneOf: [{ required: ['a'] }] } }] };
    await start();
    expect(errorMessage(await post('/v1/messages', base({ messages: leading })))).toContain('first message must use the "user" role');
    expect(errorMessage(await post('/v1/messages', base(combinator)))).toContain('does not support oneOf, allOf, or anyOf at the top level');
    await fake!.close();
    await start({ leadingAssistant: 'allow', rejectTopLevelCombinator: false });
    expect((await post('/v1/messages', base({ messages: leading }))).status).toBe(200);
    expect((await post('/v1/messages', base(combinator))).status).toBe(200);
  });

  it('refuses forced tool choice on the models named in the docs, and tool_choice none always works with tools', async () => {
    await start();
    const tools = [{ name: 'read_file', description: 'r', input_schema: { type: 'object' } }];
    expect(errorMessage(await post('/v1/messages', base({ tools, tool_choice: { type: 'any' } })))).toContain('forced tool use');
    expect((await post('/v1/messages', base({ tools, tool_choice: { type: 'none' } }))).status).toBe(200);
    expect((await post('/v1/messages', base({ model: 'claude-haiku-5-5', tools, tool_choice: { type: 'any' } }))).status).toBe(200);
    expect(errorMessage(await post('/v1/messages', base({ tool_choice: { type: 'none' } })))).toContain('tools must be provided');
  });

  it('checks structured output schemas against the grammar subset', async () => {
    await start();
    const schema = (extra: Record<string, unknown>) => ({ output_config: { format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false, required: ['n'], properties: { n: { type: 'integer', ...extra } } } } } });
    expect((await post('/v1/messages', base(schema({})))).status).toBe(200);
    expect(errorMessage(await post('/v1/messages', base(schema({ minimum: 1 }))))).toContain('minimum is not supported');
    expect(errorMessage(await post('/v1/messages', base({ output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: {} } } } })))).toContain('additionalProperties must be set to false');
    expect(errorMessage(await post('/v1/messages', base({ ...schema({}), model: 'claude-no-schema' })))).toContain('structured outputs are not supported');
  });

  it('applies the same validation to count_tokens, unless the server is told to accept anything', async () => {
    await start();
    const counted = await post('/v1/messages/count_tokens', { model: 'claude-sonnet-5-5', messages: [userText('hi')] });
    expect(counted.status).toBe(200);
    expect(counted.json.input_tokens).toBeGreaterThan(0);
    const bad = { model: 'claude-sonnet-5-5', messages: [userText('hi')], thinking: { type: 'enabled', budget_tokens: 2048 } };
    expect((await post('/v1/messages/count_tokens', bad)).status).toBe(400);
    await fake!.close();
    await start({ countTokensValidates: false });
    expect((await post('/v1/messages/count_tokens', bad)).status).toBe(200);
  });

  it('refuses a beta it does not know and the block-binding field without its beta header', async () => {
    await start();
    expect(errorMessage(await post('/v1/messages', base(), { 'anthropic-beta': 'something-else-2026-01-01' }))).toContain('anthropic-beta');
    const binding = base({ thinking: { type: 'adaptive', display: 'omitted', block_binding: { prefix_mismatch_behavior: 'error' } } });
    expect(errorMessage(await post('/v1/messages', binding))).toContain('block_binding');
    expect((await post('/v1/messages', binding, { 'anthropic-beta': FAKE_BINDING_BETA })).status).toBe(200);
    const wrongMode = base({ thinking: { type: 'adaptive', display: 'omitted', block_binding: { prefix_mismatch_behavior: 'nope' } } });
    expect((await post('/v1/messages', wrongMode, { 'anthropic-beta': FAKE_BINDING_BETA })).status).toBe(400);
  });
});

describe('fake Anthropic: thinking replay checks (S22 prefix, S9 latest run)', () => {
  const tools = [{ name: 'read_file', description: 'r', input_schema: { type: 'object' } }];
  const thinkingBase = (messages: unknown[], extra: Record<string, unknown> = {}) =>
    base({ messages, tools, thinking: { type: 'adaptive', display: 'omitted' }, system: 'You are BotBoy.', ...extra });

  /** One tool turn with a two-block thinking run; returns the assistant message exactly as the server produced it. */
  async function firstTurn() {
    fake!.reply = () => ({ content: [{ type: 'thinking', thinking: 'plan' }, { type: 'redacted_thinking' }, { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'a' } }] });
    const opening = [userText('go')];
    const answer = await post('/v1/messages', thinkingBase(opening));
    expect(answer.status).toBe(200);
    return {
      opening,
      assistant: { role: 'assistant', content: answer.json.content },
      result: (text: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: text }] }),
    };
  }

  it('is off by default (an older account): an edited history replays fine', async () => {
    await start();
    const turn = await firstTurn();
    fake!.reply = undefined;
    const edited = await post('/v1/messages', thinkingBase([{ role: 'user', content: [{ type: 'text', text: 'go (edited)' }] }, turn.assistant, turn.result('ok')]));
    expect(edited.status).toBe(200);
  });

  it('with the prefix check on, a replay is accepted when the prefix is unchanged and refused with the S22 text when it changed', async () => {
    await start({ thinkingChecks: { prefix: true } });
    const turn = await firstTurn();
    fake!.reply = undefined;
    expect((await post('/v1/messages', thinkingBase([...turn.opening, turn.assistant, turn.result('ok')]))).status).toBe(200);
    const changedEarlier = await post('/v1/messages', thinkingBase([{ role: 'user', content: [{ type: 'text', text: 'go (edited)' }] }, turn.assistant, turn.result('ok')]));
    expect(changedEarlier.status).toBe(400);
    expect(errorMessage(changedEarlier)).toContain(FAKE_SIGNATURE_400);
    const changedSystem = await post('/v1/messages', thinkingBase([...turn.opening, turn.assistant, turn.result('ok')], { system: 'Different.' }));
    expect(errorMessage(changedSystem)).toContain(FAKE_SIGNATURE_400);
    const changedTools = await post('/v1/messages', thinkingBase([...turn.opening, turn.assistant, turn.result('ok')], { tools: [...tools, { name: 'extra', description: 'e', input_schema: { type: 'object' } }] }));
    expect(errorMessage(changedTools)).toContain(FAKE_SIGNATURE_400);
    // A signature the server never produced is invalid, too.
    const forged = { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'forged' }, turn.assistant.content[2]] };
    expect(errorMessage(await post('/v1/messages', thinkingBase([...turn.opening, forged, turn.result('ok')])))).toContain(FAKE_SIGNATURE_400);
  });

  it('earlier thinking blocks are not part of the checked prefix, only earlier messages are (S22)', async () => {
    await start({ thinkingChecks: { prefix: true } });
    const turn = await firstTurn();
    // Second turn on top of the first.
    fake!.reply = () => ({ content: [{ type: 'thinking', thinking: 'more' }, { type: 'tool_use', id: 'toolu_b', name: 'read_file', input: {} }] });
    const second = await post('/v1/messages', thinkingBase([...turn.opening, turn.assistant, turn.result('ok')]));
    const secondAssistant = { role: 'assistant', content: second.json.content };
    const resultB = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'ok b' }] };
    fake!.reply = undefined;
    // Drop the FIRST run entirely: the second run's prefix (which ignores earlier thinking) still matches.
    const withoutFirstRun = { role: 'assistant', content: turn.assistant.content.filter((block: any) => block.type === 'tool_use') };
    expect((await post('/v1/messages', thinkingBase([...turn.opening, withoutFirstRun, turn.result('ok'), secondAssistant, resultB]))).status).toBe(200);
    // Editing an earlier tool result invalidates every later block.
    expect((await post('/v1/messages', thinkingBase([...turn.opening, turn.assistant, turn.result('trimmed'), secondAssistant, resultB]))).status).toBe(400);
  });

  it('with the latest-run check on, a partial or reordered run in the latest assistant message is refused with the S9 text; dropping it all is fine', async () => {
    await start({ thinkingChecks: { latestRun: true } });
    const turn = await firstTurn();
    fake!.reply = undefined;
    const [first, second, use] = turn.assistant.content;
    const partial = await post('/v1/messages', thinkingBase([...turn.opening, { role: 'assistant', content: [first, use] }, turn.result('ok')]));
    expect(partial.status).toBe(400);
    expect(errorMessage(partial)).toContain(FAKE_LATEST_RUN_400.slice(0, 80));
    expect((await post('/v1/messages', thinkingBase([...turn.opening, { role: 'assistant', content: [second, first, use] }, turn.result('ok')]))).status).toBe(400);
    expect((await post('/v1/messages', thinkingBase([...turn.opening, { role: 'assistant', content: [use] }, turn.result('ok')]))).status).toBe(200);
    expect((await post('/v1/messages', thinkingBase([...turn.opening, turn.assistant, turn.result('ok')]))).status).toBe(200);
  });

  it('forces the prefix check for any model through the beta field (the older-account path), and drop_block removes the block and says so', async () => {
    await start();
    const turn = await firstTurn();
    fake!.reply = undefined;
    const edited = [{ role: 'user', content: [{ type: 'text', text: 'go (edited)' }] }, turn.assistant, turn.result('ok')];
    const binding = (mode: string) => thinkingBase(edited, { thinking: { type: 'adaptive', display: 'omitted', block_binding: { prefix_mismatch_behavior: mode } } });
    const forced = await post('/v1/messages', binding('error'), { 'anthropic-beta': FAKE_BINDING_BETA });
    expect(forced.status).toBe(400);
    expect(errorMessage(forced)).toContain(FAKE_SIGNATURE_400);
    const counted = await post('/v1/messages/count_tokens', { ...binding('error'), max_tokens: undefined }, { 'anthropic-beta': FAKE_BINDING_BETA });
    expect(counted.status).toBe(400);
    const dropped = await post('/v1/messages', { ...binding('drop_block'), stream: true }, { 'anthropic-beta': FAKE_BINDING_BETA });
    expect(dropped.status).toBe(200);
    const start_ = frames(dropped.text).find(event => event.data.type === 'message_start')!.data.message;
    expect(start_.input_transformations).toEqual([{ type: 'dropped_thinking_block', message_index: 1, count: 2 }]);
  });
});
