import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createPromptManager } from '../core/prompt-manager.js';
import { createUiThemes, type UiThemes } from '../core/ui-theme.js';
import { withUiThemeChatTools } from '../core/ui-theme-chat-tools.js';
import type { ToolExecutionContext, ToolExecutor } from '../core/tool-executor.js';
import { createRouter } from './routes.js';

/**
 * The chat loop around ui_theme_propose (docs/maps/ui-themes.md): the tool is offered only on turns about how BotBoy looks (or just
 * after a proposal), the proposal reaches the owner as its card whether or not the reply shows it, and a reply can never apply a
 * theme. Same harness as routes.chat.mcp-servers.test.ts, with the real prompt manager and the real theme store.
 */
function streamResult(partial: Record<string, unknown>) {
  return { content: '', reasoning: '', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'stop', ...partial };
}
const PROPOSE = { name: 'ui_theme_propose', arguments: '{"name":"Evergreen","mode":"dark","accent":"#2dd4bf"}' };

describe('chat loop around ui_theme_propose', () => {
  let storage: StorageLayer;
  let db: Database.Database;
  let themes: UiThemes;
  let seen: Array<{ message: string; tools: string[]; context: ToolExecutionContext | undefined }>;
  let toolContexts: Array<ToolExecutionContext | undefined>;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
    themes = createUiThemes({ db });
    seen = [];
    toolContexts = [];
  });
  afterEach(() => storage.close());

  const lastReply = () => (db.prepare("SELECT content FROM chat_messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1").get() as any).content as string;

  function app(modelScript: (call: number, req: any) => { toolCall?: { name: string; arguments: string }; text: string }) {
    const real = createPromptManager();
    const promptManager = {
      getSystemPrompt: (role: any, context: any) => real.getSystemPrompt(role, context),
      getToolDefinitions: (role: any, context: any) => {
        const tools = real.getToolDefinitions(role, context);
        seen.push({ message: '', tools: tools.map((tool) => tool.function.name), context });
        return tools;
      },
    };
    let call = 0;
    const llmClient = {
      getActiveEndpoint: () => 'ecs',
      chatCompletionStream: vi.fn((req: any) => {
        call += 1;
        const step = modelScript(call, req);
        return (async function* () {
          if (step.toolCall && req.tools?.some((tool: any) => tool.function.name === step.toolCall!.name)) {
            yield { type: 'tool_call_start', toolCall: { index: 0, id: 'c1', name: step.toolCall.name } };
            return streamResult({ toolCalls: [{ id: 'c1', type: 'function', function: step.toolCall }], finishReason: 'tool_calls' });
          }
          yield { type: 'content', text: step.text };
          return streamResult({ content: step.text });
        })();
      }),
    };
    const base: ToolExecutor = { executeTool: vi.fn(async (c) => ({ toolCallId: c.id, content: JSON.stringify({ ok: false, error: `unknown tool ${c.function.name}` }), isError: true })) };
    const withThemes = withUiThemeChatTools(base, { themes });
    const toolExecutor: ToolExecutor = { executeTool: async (c, context) => { toolContexts.push(context); return withThemes.executeTool(c, context); } };
    const server = express();
    server.use(express.json());
    server.use('/api', createRouter({
      nodeManager: createNodeManager(db),
      db,
      llmClient: llmClient as any,
      toolExecutor,
      uiThemes: themes,
      chatInterface: { getHistory: () => [], sendMessage: async () => ({ message: { id: 'x', role: 'assistant', content: '' } }) } as any,
      promptManager: promptManager as any,
      conversationManager: {
        getActiveSessionId: () => null, createSession: () => 'sess-test', appendUser: vi.fn(), appendAssistant: vi.fn(), countUserMessages: () => 1,
        getSummary: () => null, getMessages: () => [], getMessagesSinceId: () => [], getRecentMessages: () => [], saveSummary: vi.fn(),
      } as any,
    }));
    return { server, llmClient };
  }
  const say = (server: express.Express, message: string) => request(server).post('/api/chat/messages').send({ message, stream: true });
  const chatTools = () => seen.filter((entry) => entry.tools.includes('run_command') || entry.tools.length > 5).map((entry) => entry.tools);

  it('offers the tool, and the guidance, on a turn about how BotBoy looks, and stages what the model asks for', async () => {
    const { server, llmClient } = app((call) => (call === 1 ? { toolCall: PROPOSE, text: '' } : { text: 'Here is a calm teal look. Press Preview on the card to try it.' }));
    await say(server, 'make me a teal dark theme');
    expect(chatTools()[0]).toContain('ui_theme_propose');
    const system = llmClient.chatCompletionStream.mock.calls[0][0].messages[0].content as string;
    expect(system).toContain('## Themes for the BotBoy UI');
    expect(toolContexts[0]).toMatchObject({ callerKind: 'interactive', uiThemeTurn: true });
    expect(themes.view().themes).toEqual([]);
    const pending = db.prepare("SELECT value FROM app_settings WHERE key = 'ui.themes.v1'").get() as { value: string };
    const stored = JSON.parse(pending.value);
    expect(stored.proposals).toHaveLength(1);
    expect(stored.proposals[0]).toMatchObject({ name: 'Evergreen', status: 'pending' });
    expect(stored.active).toBeNull();
  });

  it('appends the card the reply did not show, once, on its own line', async () => {
    const { server } = app((call) => (call === 1 ? { toolCall: PROPOSE, text: '' } : { text: 'Here is a calm teal look.' }));
    await say(server, 'try a teal color scheme');
    const stored = JSON.parse((db.prepare("SELECT value FROM app_settings WHERE key = 'ui.themes.v1'").get() as { value: string }).value);
    const id = stored.proposals[0].id as string;
    expect(lastReply()).toBe(`Here is a calm teal look.\n\n[[theme:${id}]]`);
  });

  it('leaves the card where the model put it', async () => {
    let id = '';
    const { server } = app((call) => {
      if (call === 1) return { toolCall: PROPOSE, text: '' };
      id = (JSON.parse((db.prepare("SELECT value FROM app_settings WHERE key = 'ui.themes.v1'").get() as { value: string }).value).proposals[0].id as string);
      return { text: `A teal look:\n[[theme:${id}]]\nPreview it first.` };
    });
    await say(server, 'new theme please');
    expect(lastReply()).toBe(`A teal look:\n[[theme:${id}]]\nPreview it first.`);
  });

  it('does not offer the tool, or its guidance, on an ordinary turn (a call to it anyway is refused: ui-theme-chat-tools.test.ts)', async () => {
    const { server, llmClient } = app((call) => (call === 1 ? { toolCall: PROPOSE, text: 'I have nothing to propose.' } : { text: 'Your open tasks are in Today.' }));
    await say(server, 'what are my open tasks');
    for (const tools of chatTools()) expect(tools).not.toContain('ui_theme_propose');
    expect(llmClient.chatCompletionStream.mock.calls[0][0].messages[0].content as string).not.toContain('## Themes for the BotBoy UI');
    expect(toolContexts.every((context) => context?.uiThemeTurn !== true)).toBe(true);
    expect(JSON.parse((db.prepare("SELECT value FROM app_settings WHERE key = 'ui.themes.v1'").get() as { value: string } | undefined)?.value ?? '{"proposals":[]}').proposals).toEqual([]);
  });

  it('a follow-up minutes after a proposal ("a bit greener") is still a theme turn', async () => {
    const first = app((call) => (call === 1 ? { toolCall: PROPOSE, text: '' } : { text: 'Teal.' }));
    await say(first.server, 'make me a theme');
    seen = [];
    const second = app((call) => (call === 1 ? { toolCall: { name: 'ui_theme_propose', arguments: '{"name":"Greener","mode":"dark","accent":"#22c55e"}' }, text: '' } : { text: 'Greener.' }));
    await say(second.server, 'a bit greener, please');
    expect(chatTools()[0]).toContain('ui_theme_propose');
    expect(themes.hasRecentProposal()).toBe(true);
    const stored = JSON.parse((db.prepare("SELECT value FROM app_settings WHERE key = 'ui.themes.v1'").get() as { value: string }).value);
    expect(stored.proposals.map((proposal: any) => proposal.name).sort()).toEqual(['Evergreen', 'Greener']);
  });

  it('whatever the reply says, nothing is applied: only the owner\'s click on the card or the page changes the theme', async () => {
    const { server } = app((call) => (call === 1 ? { toolCall: PROPOSE, text: '' } : { text: "I've applied the Evergreen theme for you." }));
    await say(server, 'switch me to a teal dark theme');
    const stored = JSON.parse((db.prepare("SELECT value FROM app_settings WHERE key = 'ui.themes.v1'").get() as { value: string }).value);
    expect(stored.active).toBeNull();
    expect(stored.themes).toEqual([]);
    expect(themes.htmlAttributes()).toBeNull();
  });
});
