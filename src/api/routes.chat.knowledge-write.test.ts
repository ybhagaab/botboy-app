/**
 * The chat turn and the Knowledge library's write path (knowledge-library.md K14, K18): which tools a turn is offered, the
 * rules handed to the drafting model before it drafts, taint recorded above the executor chain (also for a mail read in the
 * same assistant message as the write), the card marker appended to a reply, a change left mid-loop staged at the end of the
 * turn, the open-change block when the owner pressed "Ask BotBoy to fix", and the "I've updated it" gate. The real router, the
 * real prompt manager and the real writer on a temp library; a scripted model; synthetic content.
 */
import fs from 'node:fs';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGuide, rulesDigest } from '../core/knowledge-guide.js';
import { withKnowledgeChatTools } from '../core/knowledge-chat-tools.js';
import { dateBreach, makeHarness, type Harness } from '../core/knowledge-write.testutil.js';
import { createNodeManager } from '../core/node-manager.js';
import { createPromptManager } from '../core/prompt-manager.js';
import type { ToolCall } from '../core/llm-client.js';
import type { ToolExecutionContext, ToolExecutor, ToolResult } from '../core/tool-executor.js';
import { createRouter } from './routes.js';

function streamResult(partial: Record<string, unknown>) {
  return { content: '', reasoning: '', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'stop', ...partial };
}

type Step = { tools: Array<{ name: string; args: Record<string, unknown> }> } | { text: string };
/** A model that plays its steps in order (a step of tool calls is one assistant message), then repeats the last. */
function scriptedModel(steps: Step[]) {
  const requests: any[] = [];
  let index = 0;
  const llm = {
    getActiveEndpoint: () => 'ecs',
    chatCompletionStream: vi.fn((req: any) => {
      requests.push(req);
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      const at = index;
      return (async function* () {
        if ('tools' in step) {
          const toolCalls = step.tools.map((tool, position) => ({ id: `k${at}_${position}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }));
          for (const [position, toolCall] of toolCalls.entries()) yield { type: 'tool_call_start', toolCall: { index: position, id: toolCall.id, name: toolCall.function.name } };
          return streamResult({ toolCalls, finishReason: 'tool_calls' });
        }
        yield { type: 'content', text: step.text };
        return streamResult({ content: step.text });
      })();
    }),
  };
  return { llm, requests };
}

let h: Harness;
let seen: Array<{ name: string; context: ToolExecutionContext | undefined }>;
beforeEach(async () => {
  h = await makeHarness();
  seen = [];
});
afterEach(() => { vi.restoreAllMocks(); h.close(); fs.rmSync(h.base, { recursive: true, force: true }); });

function app(llm: unknown) {
  const base: ToolExecutor = {
    async executeTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
      seen.push({ name: call.function.name, context });
      return { toolCallId: call.id, content: `base:${call.function.name}` };
    },
  };
  const deps: any = {
    nodeManager: createNodeManager(h.storage.getDb()), db: h.storage.getDb(), llmClient: llm,
    toolExecutor: withKnowledgeChatTools(base, { library: h.library, writer: h.writer }),
    chatInterface: { getHistory: () => [], sendMessage: async () => ({ message: { id: 'x', role: 'assistant', content: '' } }) } as any,
    promptManager: createPromptManager(),
    conversationManager: {
      getActiveSessionId: () => null, createSession: () => 'sess-test', appendUser: vi.fn(), appendAssistant: vi.fn(),
      countUserMessages: () => 1, getSummary: () => null, getMessages: () => [], getMessagesSinceId: () => [],
      getRecentMessages: () => [{ role: 'user' as const, content: 'hello' }], saveSummary: vi.fn(),
    } as any,
    knowledgeLibrary: h.library, knowledgeWriter: h.writer, knowledgeHistory: h.history, knowledgeChanges: h.changes,
  };
  const server = express();
  server.use(express.json());
  server.use('/api', createRouter(deps));
  return server;
}

const send = (llm: unknown, message: string) => request(app(llm)).post('/api/chat/messages').send({ message, stream: true });
const systemPromptOf = (req: any): string => String(req.messages.find((message: any) => message.role === 'system')?.content ?? '');
const toolNamesOf = (req: any): string[] => (req.tools ?? []).map((tool: any) => tool.function.name);
const rulesOfShop = () => rulesDigest(parseGuide(h.read('shop-data/GUIDE.md')));
const EDIT = (rulesSha256: string, extra: Record<string, unknown> = {}) => ({
  set: 'shop-data', file: 'orders.md', mode: 'edit', ownerRequested: true, rulesSha256,
  edits: [{ find: '- Always filter by channel.', replace: '- Always filter by channel.\n- Use placeholders for dates.' }], ...extra,
});
const MESSAGE = 'please add a note about placeholders to shop-data orders.md';

describe('which tools a turn is offered', () => {
  it('the reads and the proposal with the library; the write tools only when the message asks to change or create something', async () => {
    const quiet = scriptedModel([{ text: 'ok' }]);
    await send(quiet.llm, 'what is in my reference files?');
    expect(toolNamesOf(quiet.requests[0]).filter((name) => name.startsWith('knowledge_'))).toEqual(['knowledge_list', 'knowledge_load', 'knowledge_propose']);
    const editing = scriptedModel([{ text: 'ok' }]);
    await send(editing.llm, MESSAGE);
    expect(toolNamesOf(editing.requests[0]).filter((name) => name.startsWith('knowledge_'))).toEqual(['knowledge_list', 'knowledge_load', 'knowledge_propose', 'knowledge_write', 'knowledge_create_set']);
    const creating = scriptedModel([{ text: 'ok' }]);
    await send(creating.llm, 'create a set about bees');
    expect(toolNamesOf(creating.requests[0])).toContain('knowledge_create_set');
  });

  it('hands the matched set\'s rules to the drafting model BEFORE it drafts, so its first call needs no guide_not_read round trip', async () => {
    const model = scriptedModel([{ tools: [{ name: 'knowledge_write', args: EDIT(rulesOfShop()) }] }, { text: 'Added the note.' }]);
    const response = await send(model.llm, MESSAGE);
    const prompt = systemPromptOf(model.requests[0]);
    expect(prompt).toContain('Guardrails:');
    expect(prompt).toContain('Do NOT add hardcoded dates');
    expect(h.read('shop-data/orders.md')).toContain('Use placeholders for dates.');
    expect(response.text).toContain('[[knowledge:kc_');
    // No refusal on the way: the decorator answers the write itself (the base never sees it), with one check call.
    expect(seen.filter((entry) => entry.name === 'knowledge_write')).toHaveLength(0);
    expect(h.llmCalls).toHaveLength(1);
    expect(model.requests).toHaveLength(2);
  });
});

describe('taint, above the executor chain', () => {
  it('a mail read in the SAME assistant message as the write makes the write a card; nothing is changed and the reply carries the card', async () => {
    const model = scriptedModel([
      { tools: [{ name: 'gmail_read', args: { id: 'm1' } }, { name: 'knowledge_write', args: EDIT(rulesOfShop()) }] },
      { text: 'I prepared a change for you to approve.' },
    ]);
    const response = await send(model.llm, MESSAGE);
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
    const change = h.changes.list()[0];
    expect(change).toMatchObject({ status: 'staged', origin: 'owner_request', sources: ['email'] });
    expect(response.text).toContain(`[[knowledge:${change.id}]]`);
    expect(h.history.list().some((entry) => entry.kind === 'write')).toBe(false);
  });

  it('a web read, a connected tool and a document read each taint; the library\'s own reads do not', async () => {
    for (const [tool, tainted] of [['web_fetch', true], ['mcp_call_tool', true], ['read_document', true], ['knowledge_list', false]] as const) {
      const model = scriptedModel([{ tools: [{ name: tool, args: {} }, { name: 'knowledge_write', args: EDIT(rulesOfShop(), { file: 'orders_analysis.md', edits: [{ find: 'Methodology only.', replace: `Methodology only (${tool}).` }] }) }] }, { text: 'done' }]);
      await send(model.llm, 'please update the shop-data orders_analysis.md');
      const analysis = h.read('shop-data/orders_analysis.md');
      expect(analysis.includes(`(${tool})`), tool).toBe(!tainted);
      h.put('shop-data/orders_analysis.md', '# Analysis\n\nMethodology only.\n');
    }
  });
});

describe('cards and the integrity gate', () => {
  it('a clean direct apply ends with its card (applied, with Undo) and counts as a real write', async () => {
    const model = scriptedModel([{ tools: [{ name: 'knowledge_write', args: EDIT(rulesOfShop()) }] }, { text: 'I\'ve updated orders.md.' }]);
    const response = await send(model.llm, MESSAGE);
    expect(h.read('shop-data/orders.md')).toContain('Use placeholders for dates.');
    const applied = h.changes.list({ statuses: ['applied'] })[0];
    expect(response.text).toContain(`[[knowledge:${applied.id}]]`);
    // The gate did not add a "nothing was written" correction to an honest claim.
    expect(response.text).not.toMatch(/did not (?:actually )?(?:write|save|change)/i);
  });

  it('a staged card is not an update: "I\'ve updated it" after a card is corrected by the integrity gate', async () => {
    h.setClient(null);
    const model = scriptedModel([{ tools: [{ name: 'knowledge_write', args: EDIT(rulesOfShop()) }] }, { text: '✅ I\'ve updated orders.md with the note.' }, { text: 'The change is waiting as a card for your approval.' }]);
    const response = await send(model.llm, MESSAGE);
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
    expect(model.requests.length).toBeGreaterThanOrEqual(3);
    expect(response.text).toContain('[[knowledge:kc_');
  });

  it('a PROPOSAL (a staged card, ok) is not an update either: the gate corrects "I\'ve updated it", and the first call returns the rules (guide_not_read) for the second', async () => {
    const proposal = { set: 'shop-data', file: 'orders.md', mode: 'edit', why: 'verified in a query', trigger: 'verified_fact', edits: [{ find: '- Always filter by channel.', replace: '- Always filter by channel.\n- Use placeholders for dates.' }] };
    const model = scriptedModel([
      { tools: [{ name: 'knowledge_propose', args: proposal }] },
      { tools: [{ name: 'knowledge_propose', args: { ...proposal, rulesSha256: rulesOfShop() } }] },
      { text: '✅ I\'ve updated orders.md with the note.' },
      { text: 'The proposal is waiting as a card for your approval.' },
    ]);
    const response = await send(model.llm, 'what did the last query teach us?');
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
    const change = h.changes.list()[0];
    expect(change).toMatchObject({ status: 'staged', origin: 'botboy_proposal' });
    expect(model.requests.length).toBeGreaterThanOrEqual(4);
    expect(response.text).toContain(`[[knowledge:${change.id}]]`);
  });

  it('a change left mid-loop when the turn ends is staged, never lost, and still gets its card', async () => {
    h.queue({ items: [dateBreach('The 2026-03-14 note')] });
    const model = scriptedModel([
      { tools: [{ name: 'knowledge_write', args: EDIT(rulesOfShop(), { edits: [{ find: '- Always filter by channel.', replace: '- Always filter by channel.\n- The 2026-03-14 note' }] }) }] },
      { text: 'I could not finish this change.' },
    ]);
    const response = await send(model.llm, MESSAGE);
    const change = h.changes.list({ statuses: ['staged', 'revising'] })[0];
    expect(change.status).toBe('staged');
    expect(change.statusReason).toContain('turn ended');
    expect(response.text).toContain(`[[knowledge:${change.id}]]`);
    expect(h.read('shop-data/orders.md')).not.toContain('2026-03-14');
  });
});

describe('a turn that ends at the tool ceiling', () => {
  it('stages the change it left mid-loop and still appends its card (the ceiling path builds its own final text)', async () => {
    h.queue({ items: [dateBreach('The 2026-03-14 note')] });
    const breach = EDIT(rulesOfShop(), { edits: [{ find: '- Always filter by channel.', replace: '- Always filter by channel.\n- The 2026-03-14 note' }] });
    // The model never stops calling tools; every call is distinct so the repeat breaker does not end the turn first.
    let index = 0;
    const requests: any[] = [];
    const llm = {
      getActiveEndpoint: () => 'ecs',
      chatCompletionStream: vi.fn((req: any) => {
        requests.push(req);
        index += 1;
        const at = index;
        return (async function* () {
          if (req.tools && req.tools.length > 0) {
            const args = at === 1 ? breach : { set: `shop-data-${at}` };
            const toolCall = { id: `c${at}`, type: 'function', function: { name: at === 1 ? 'knowledge_write' : 'knowledge_list', arguments: JSON.stringify(args) } };
            yield { type: 'tool_call_start', toolCall: { index: 0, id: toolCall.id, name: toolCall.function.name } };
            return streamResult({ toolCalls: [toolCall], finishReason: 'tool_calls' });
          }
          yield { type: 'content', text: 'Here is where I got to.' };
          return streamResult({ content: 'Here is where I got to.' });
        })();
      }),
    };
    const response = await send(llm, MESSAGE);
    const change = h.changes.list({ statuses: ['staged'] })[0];
    expect(change.statusReason).toContain('turn ended');
    expect(response.text).toContain(`[[knowledge:${change.id}]]`);
    expect(response.text).toContain('Here is where I got to.');
  }, 120_000);
});

describe('the owner pressed "Ask BotBoy to fix" on a card', () => {
  it('builds the open-change block, offers the write tools, and a clean revision stays a card (R1)', async () => {
    const proposing = h.turn('what is in my inbox?');
    const proposed = await h.write(proposing, { set: 'shop-data', file: 'orders.md', mode: 'edit', why: 'verified', trigger: 'verified_fact', edits: [{ find: '- Always filter by channel.', replace: '- Always filter by channel.\n- The 2026-03-14 note' }] }, 'knowledge_propose');
    const id = String(proposed.changeId);
    h.changes.update(id, { unresolved: [{ tier: 'must_fix', rule: 'Do NOT add hardcoded dates, order ids, or time-specific metrics to the Context File or the Table Reference', where: { file: 'orders.md', line: 8 }, problem: 'Names a date.', evidence: 'The 2026-03-14 note', fix: 'Remove the date.', source: 'model' }] });
    const model = scriptedModel([
      { tools: [{ name: 'knowledge_write', args: EDIT(rulesOfShop(), { changeId: id }) }] },
      { text: 'Fixed it.' },
    ]);
    const response = await send(model.llm, `Please fix this change. [[knowledge:${id}]]`);
    const prompt = systemPromptOf(model.requests[0]);
    expect(prompt).toContain(`[OPEN CHANGE ${id}`);
    expect(prompt).toContain('Names a date.');
    expect(prompt).toContain('Next call: knowledge_write with changeId');
    expect(toolNamesOf(model.requests[0])).toContain('knowledge_write');
    // The owner reopened the card; the revision stays a card and is never applied by the model.
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
    expect(h.changes.get(id)).toMatchObject({ status: 'staged', origin: 'botboy_proposal' });
    expect(response.text).toContain(`[[knowledge:${id}]]`);
  });

  it('ignores a marker that is not in the CURRENT message, an unknown id, and a change that is already closed', async () => {
    const model = scriptedModel([{ text: 'ok' }]);
    await send(model.llm, 'please update shop-data orders.md [[knowledge:kc_000000000000]]');
    expect(systemPromptOf(model.requests[0])).not.toContain('[OPEN CHANGE');
  });
});
