import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { elideImageDataUrls, renderMarkdown, type LlmPromptLogEntry } from './llm-prompt-log.js';

/**
 * The prompt log keeps the exact wire body readable. The Anthropic Messages body differs from the other two in three ways
 * that matter here: the system prompt is a top-level `system` string, tools are flat, and an image is a base64 block
 * (`source.data`) rather than a data URL, so its bytes must be elided the same way.
 */
const BASE64_150 = 'iVBORw0KGgo'.padEnd(150, 'A');

function messagesBody(): Record<string, unknown> {
  return {
    model: 'claude-sonnet-5-5',
    max_tokens: 4096,
    stream: true,
    system: 'You are BotBoy.\nSecond line of the system prompt.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'What is in this picture?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BASE64_150 } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } }] },
    ],
    tools: [{ name: 'read_file', description: 'Read a file.', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    cache_control: { type: 'ephemeral' },
  };
}
const entryFor = (request: unknown): LlmPromptLogEntry => ({ url: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-5-5', apiMode: 'messages', stream: true, request });

describe('elideImageDataUrls', () => {
  it('replaces an Anthropic base64 image payload with its size and first characters, leaving the rest of the body intact', () => {
    const body = messagesBody();
    const elided = elideImageDataUrls(body) as any;
    const image = elided.messages[0].content[1];
    expect(image.type).toBe('image');
    expect(image.source.type).toBe('base64');
    expect(image.source.media_type).toBe('image/png');
    expect(image.source.data).toMatch(/^image-elided \(150 chars, starts iVBORw0KGgoAAAAAAAAAAAAA…\)$/);
    expect(JSON.stringify(elided)).not.toContain(BASE64_150);
    // Everything else is the original body, byte for byte.
    expect(elided.system).toBe(body.system);
    expect(elided.messages[0].content[0]).toEqual({ type: 'text', text: 'What is in this picture?' });
    expect(elided.messages[1]).toEqual((body.messages as any[])[1]);
    expect(elided.tools).toEqual(body.tools);
    expect(elided.cache_control).toEqual({ type: 'ephemeral' });
    // The input is not mutated.
    expect((body.messages as any)[0].content[1].source.data).toBe(BASE64_150);
  });

  it('still elides a data URL, handles several images, and returns an image-free body as the same object', () => {
    const dataUrl = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${BASE64_150}` } }] }] };
    expect(JSON.stringify(elideImageDataUrls(dataUrl))).toContain('data:image-elided (');
    const two = { messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: BASE64_150 } },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: BASE64_150 + 'BBBB' } },
    ] }] };
    const json = JSON.stringify(elideImageDataUrls(two));
    expect(json.match(/image-elided/g)).toHaveLength(2);
    expect(json).toContain('image-elided (154 chars');
    const plain = { model: 'm', messages: [{ role: 'user', content: 'hello' }] };
    expect(elideImageDataUrls(plain)).toBe(plain);
  });

  it('leaves a payload shorter than 64 characters alone (nothing to save) and a non-image base64 source untouched', () => {
    const tiny = { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }] };
    expect(JSON.stringify(elideImageDataUrls(tiny))).toContain('iVBORw0KGgo=');
    const pdf = { messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: BASE64_150 } }] }] };
    expect(JSON.stringify(elideImageDataUrls(pdf))).toContain(BASE64_150);
  });
});

describe('renderMarkdown for an Anthropic Messages body', () => {
  const render = (body: unknown) => renderMarkdown(new Date('2026-10-13T10:00:00Z'), entryFor(elideImageDataUrls(body)), JSON.stringify(body).length);

  it('shows the top-level system prompt verbatim under its own heading and does not repeat it under Other params', () => {
    const markdown = render(messagesBody());
    expect(markdown).toContain('## System prompt\n\nYou are BotBoy.\nSecond line of the system prompt.');
    const other = markdown.slice(markdown.indexOf('## Other params'));
    expect(other).toContain('"max_tokens": 4096');
    expect(other).toContain('"cache_control"');
    expect(other).not.toContain('You are BotBoy');
    expect(markdown).not.toContain('"system"');
  });

  it('lists flat tools by name, renders each turn, and carries the elided image marker, not its bytes', () => {
    const markdown = render(messagesBody());
    expect(markdown).toContain('## Tools (1)\n\nread_file');
    expect(markdown).toContain('## Conversation input (2 items)');
    expect(markdown).toContain('### [0] user');
    expect(markdown).toContain('What is in this picture?');
    expect(markdown).toContain('### [1] assistant');
    expect(markdown).toContain('"name": "read_file"');
    expect(markdown).toContain('image-elided (150 chars');
    expect(markdown).not.toContain(BASE64_150);
    expect(markdown).toContain('- **apiMode**: messages (streaming)');
  });

  it('keeps the existing Responses and chat-completions renderings unchanged', () => {
    const responses = render({ model: 'm', instructions: 'Be brief.', input: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', name: 'f', parameters: {} }] });
    expect(responses).toContain('## Instructions (system prompt)\n\nBe brief.');
    expect(responses).not.toContain('## System prompt');
    const chat = render({ model: 'm', messages: [{ role: 'system', content: 'Sys.' }, { role: 'user', content: 'hi' }], temperature: 0 });
    expect(chat).toContain('### [0] system');
    expect(chat).toContain('"temperature": 0');
    // A body whose `system` is not a string (a block array) is not hidden: it stays under Other params only if it is not the string form.
    const blocks = render({ model: 'm', system: [{ type: 'text', text: 'Blocks.' }], messages: [] });
    expect(blocks).not.toContain('## System prompt');
  });
});

describe('logLlmPrompt writes the pair for a Messages request', () => {
  const originalHome = process.env.HOME;
  const originalLog = process.env.BOTBOY_LLM_PROMPT_LOG;
  const homes: string[] = [];
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalLog === undefined) delete process.env.BOTBOY_LLM_PROMPT_LOG; else process.env.BOTBOY_LLM_PROMPT_LOG = originalLog;
    vi.resetModules();
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });

  async function loadWithHome(): Promise<{ mod: typeof import('./llm-prompt-log.js'); dir: string }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-promptlog-'));
    homes.push(home);
    process.env.HOME = home;
    delete process.env.BOTBOY_LLM_PROMPT_LOG;
    vi.resetModules();
    const mod = await import('./llm-prompt-log.js');
    expect(mod.llmPromptLogDir().startsWith(home)).toBe(true);
    return { mod, dir: mod.llmPromptLogDir() };
  }
  async function filesIn(dir: string, count: number): Promise<string[]> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      // A file is listed from the moment the writer opens it, before its content lands: wait until each one holds content
      // too, or a read in that gap sees an empty file ("Unexpected end of JSON input", seen in 3 of 20 parallel runs).
      const written = names.length >= count && names.every(name => fs.statSync(path.join(dir, name)).size > 0);
      if (written || Date.now() > deadline) return names.sort();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  it('writes a .json twin with the elided body and a .md twin with the system prompt, named for the messages api mode', async () => {
    const { mod, dir } = await loadWithHome();
    mod.logLlmPrompt({ ...entryFor(messagesBody()), imageCount: 1, imageChars: 150 });
    const names = await filesIn(dir, 2);
    expect(names).toHaveLength(2);
    const json = names.find(name => name.endsWith('.json'))!;
    const markdown = names.find(name => name.endsWith('.md'))!;
    expect(json).toMatch(/_messages-stream_[a-z0-9]{1,4}\.json$/);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, json), 'utf8'));
    expect(parsed).toMatchObject({ apiMode: 'messages', stream: true, model: 'claude-sonnet-5-5', imageCount: 1, imageChars: 150 });
    expect(parsed.request.system).toBe('You are BotBoy.\nSecond line of the system prompt.');
    expect(parsed.request.messages[0].content[1].source.data).toMatch(/^image-elided \(150 chars/);
    const text = fs.readFileSync(path.join(dir, markdown), 'utf8');
    expect(text).toContain('## System prompt');
    expect(text).not.toContain(BASE64_150);
    // No credential can reach the log: the request object has no header, and the file holds no key-shaped text.
    expect(fs.readFileSync(path.join(dir, json), 'utf8')).not.toMatch(/sk-ant-|x-api-key/i);
  });

  it('writes nothing when BOTBOY_LLM_PROMPT_LOG=0', async () => {
    const { mod, dir } = await loadWithHome();
    process.env.BOTBOY_LLM_PROMPT_LOG = '0';
    mod.logLlmPrompt(entryFor(messagesBody()));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(fs.existsSync(dir)).toBe(false);
  });
});
