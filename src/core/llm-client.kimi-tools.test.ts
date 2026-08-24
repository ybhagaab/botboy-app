import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLlmClient, stripKimiToolMarkup } from './llm-client.js';

/**
 * Kimi K2/K2.5 emit tool calls as TEXT in their own token markup instead of the
 * OpenAI `tool_calls` field. Before this was parsed, the markup landed in the
 * chat bubble as prose, the tool never ran, and the model told the user their
 * file was saved when nothing had been written (post-mortem 2026-08-05:
 * "current agent keeps failing to save html files reliably").
 */

const KIMI_CALL =
  '<|tool_calls_section_begin|><|tool_call_begin|>functions.write_file:0<|tool_call_argument_begin|>' +
  '{"filename":"dashboard.html","content":"<!DOCTYPE html><html></html>","mode":"overwrite"}' +
  '<|tool_call_end|><|tool_calls_section_end|>';

function config() {
  return {
    ecs: { endpoint: 'http://kimi.test', model: 'moonshotai.kimi-k2.5', maxContextTokens: 262144, requestTimeoutMs: 0 },
    ollama: { endpoint: '', model: '', maxContextTokens: 0, requestTimeoutMs: 0 },
    defaults: { temperature: 0.7, maxCompletionTokens: 4096, contextBudgetTokens: 200000 },
    healthCheckIntervalMs: 3_600_000,
    fallbackEnabled: false,
  };
}

/** Fake an OpenAI-compatible non-streaming response body. */
function mockJsonResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content, tool_calls: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    text: async () => '',
  } as any;
}

/** Fake an SSE stream that emits `content` split across chunks. */
function mockStreamResponse(pieces: string[]) {
  const encoder = new TextEncoder();
  const events = pieces.map(
    (p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`,
  );
  events.push('data: [DONE]\n\n');
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () =>
          i < events.length ? { done: false, value: encoder.encode(events[i++]) } : { done: true, value: undefined },
        releaseLock: () => {},
      }),
    },
    text: async () => '',
  } as any;
}

describe('Kimi tool-call markup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stripKimiToolMarkup removes the markup and keeps surrounding prose', () => {
    const out = stripKimiToolMarkup(`Let me save that for you.\n${KIMI_CALL}`);
    expect(out).toBe('Let me save that for you.');
    expect(out).not.toContain('tool_call');
  });

  it('parses a text-markup tool call from a non-streaming response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockJsonResponse(`Saving now.\n${KIMI_CALL}`)));
    const client = createLlmClient(config());
    const resp = await client.chatCompletion({
      messages: [{ role: 'user', content: 'make a dashboard' }],
      tools: [{ type: 'function', function: { name: 'write_file', description: 'w', parameters: {} } }],
    });
    client.close();

    expect(resp.toolCalls).toHaveLength(1);
    expect(resp.toolCalls![0].function.name).toBe('write_file');
    const args = JSON.parse(resp.toolCalls![0].function.arguments);
    expect(args.filename).toBe('dashboard.html');
    expect(args.content).toContain('<!DOCTYPE html>');
    expect(args.mode).toBe('overwrite');
    // The markup must not leak into the user-visible message.
    expect(resp.content).not.toContain('tool_call');
    expect(resp.content).toContain('Saving now.');
  });

  it('streaming: markup is parsed into a tool call and never streamed to the UI', async () => {
    // Split the markup across chunk boundaries, as a real stream would.
    const pieces = ['Working on it. ', '<|tool_calls_section_begin|><|tool_call_begin|>functions.write', '_file:0<|tool_call_argument_begin|>{"filename":"a.html",', '"content":"<h1>hi</h1>"}<|tool_call_end|><|tool_calls_section_end|>'];
    vi.stubGlobal('fetch', vi.fn(async () => mockStreamResponse(pieces)));
    const client = createLlmClient(config());

    const streamed: string[] = [];
    const gen = client.chatCompletionStream({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'write_file', description: 'w', parameters: {} } }],
      think: false,
    });
    let step = await gen.next();
    while (!step.done) {
      if (step.value.type === 'content') streamed.push(step.value.text || '');
      step = await gen.next();
    }
    const result = step.value;
    client.close();

    // No markup tokens reached the UI…
    const visible = streamed.join('');
    expect(visible).toBe('Working on it. ');
    expect(visible).not.toContain('tool_call');
    // …and the call was recovered from the accumulated text.
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('write_file');
    expect(JSON.parse(result.toolCalls[0].function.arguments).filename).toBe('a.html');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.content).not.toContain('tool_call');
  });

  // ── Tools withheld on purpose ────────────────────────────────────────────
  // The chat loop's repeat-breaker sends `tools: []` to force a text answer,
  // and the cap-synthesis call omits tools entirely. Kimi still emits its
  // markup in that state (verified against Bedrock), so parsing it back into an
  // executable call would defeat the caller's intent (post-mortem 2026-08-05).

  it('non-streaming: withheld tools -> markup stripped, nothing executed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockJsonResponse(`I'll save that now.\n${KIMI_CALL}`)));
    const client = createLlmClient(config());
    const resp = await client.chatCompletion({
      messages: [{ role: 'user', content: 'save it' }],
      tools: [], // kill-switch shape
    });
    client.close();

    expect(resp.toolCalls).toBeNull();
    expect(resp.content).not.toContain('tool_call');
    expect(resp.content).toContain("I'll save that now.");
  });

  it('streaming: withheld tools -> markup stripped, no tool calls returned', async () => {
    const pieces = ['Working on it. ', KIMI_CALL];
    vi.stubGlobal('fetch', vi.fn(async () => mockStreamResponse(pieces)));
    const client = createLlmClient(config());

    const gen = client.chatCompletionStream({
      messages: [{ role: 'user', content: 'save it' }],
      tools: [],
      think: false,
    });
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    const result = step.value;
    client.close();

    expect(result.toolCalls).toHaveLength(0);
    expect(result.finishReason).not.toBe('tool_calls');
    expect(result.content).not.toContain('tool_call');
    expect(result.content).toContain('Working on it.');
  });

  it('streaming: tools OFFERED -> the same markup IS parsed (no regression)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockStreamResponse(['ok ', KIMI_CALL])));
    const client = createLlmClient(config());

    const gen = client.chatCompletionStream({
      messages: [{ role: 'user', content: 'save it' }],
      tools: [{ type: 'function', function: { name: 'write_file', description: 'w', parameters: {} } }],
      think: false,
    });
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    const result = step.value;
    client.close();

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('write_file');
    expect(result.finishReason).toBe('tool_calls');
  });

  it('keeps truncated argument JSON raw so the caller can detect the cut-off', async () => {
    // Argument JSON cut mid-string (what an output-token limit produces).
    const truncated =
      '<|tool_call_begin|>functions.write_file:0<|tool_call_argument_begin|>{"filename":"big.html","content":"<!DOCTYPE html><div>unterminated';
    vi.stubGlobal('fetch', vi.fn(async () => mockJsonResponse(truncated)));
    const client = createLlmClient(config());
    const resp = await client.chatCompletion({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'write_file', description: 'w', parameters: {} } }],
    });
    client.close();

    expect(resp.toolCalls).toHaveLength(1);
    const args = resp.toolCalls![0].function.arguments;
    // Raw (invalid JSON) — NOT silently replaced with '{}', which would have
    // executed write_file with no filename/content.
    expect(() => JSON.parse(args)).toThrow();
    expect(args).toContain('big.html');
  });
});
