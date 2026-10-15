/**
 * The three write tools through the whole executor chain index.ts builds (knowledge-library.md K18): the job mandate in front,
 * the decorator answering before the base, a whole GUIDE.md load as a rules delivery, a library file load as a possible
 * source for a guide edit, structured answers with an effect, and a continuation that may propose but never write. A real
 * writer, journal and changes store on a temp library; synthetic content.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatJobStore, type ChatJobStore } from './chat-jobs.js';
import { withJobMandate } from './job-mandate.js';
import { withKnowledgeChatTools } from './knowledge-chat-tools.js';
import { parseGuide, rulesDigest } from './knowledge-guide.js';
import { makeHarness, type Harness } from './knowledge-write.testutil.js';
import type { ToolCall } from './llm-client.js';
import type { ToolExecutionContext, ToolExecutor, ToolResult } from './tool-executor.js';
import { withWorkplaceChatTools } from './workplace-chat-tools.js';

let h: Harness;
let jobs: ChatJobStore;
beforeEach(async () => { h = await makeHarness(); jobs = createChatJobStore(h.storage.getDb()); });
afterEach(() => { vi.restoreAllMocks(); h.close(); fs.rmSync(h.base, { recursive: true, force: true }); });

const call = (name: string, args: Record<string, unknown> = {}, id = `${name}-1`): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const json = (result: ToolResult) => JSON.parse(result.content);
const base: ToolExecutor = { async executeTool(toolCall) { if (toolCall.function.name.startsWith('knowledge_')) throw new Error('reached the base'); return { toolCallId: toolCall.id, content: `base:${toolCall.function.name}` }; } };
const chain = () => withJobMandate(withWorkplaceChatTools(withKnowledgeChatTools(base, { library: h.library, writer: h.writer }), {}), { jobs });
const digest = () => rulesDigest(parseGuide(h.read('shop-data/GUIDE.md')));
const EDIT = { set: 'shop-data', file: 'orders.md', mode: 'edit', ownerRequested: true, edits: [{ find: '- Always filter by channel.', replace: '- Always filter by channel.\n- Use placeholders for dates.' }] };
const MESSAGE = 'please add a note about placeholders to shop-data orders.md';

describe('the write tools through the chain', () => {
  it('a live owner turn: the first call without a digest returns the rules (guide_not_read, effect none), the second applies, and the answers are structured objects', async () => {
    const context = h.turn(MESSAGE);
    const first = json(await chain().executeTool(call('knowledge_write', EDIT), context));
    expect(first).toMatchObject({ ok: false, code: 'guide_not_read', effect: 'none', rulesSha256: digest() });
    const second = json(await chain().executeTool(call('knowledge_write', { ...EDIT, rulesSha256: first.rulesSha256 }, 'w2'), context));
    expect(second).toMatchObject({ ok: true, status: 'applied', effect: 'applied' });
    expect(second.nextAction).toBeTruthy();
    expect(h.read('shop-data/orders.md')).toContain('Use placeholders for dates.');
  });

  it('a whole GUIDE.md load is a whole-guide delivery: its digest is accepted for a write to any file of the set, and a partial read is not', async () => {
    const context = h.turn(MESSAGE);
    const loaded = await chain().executeTool(call('knowledge_load', { set: 'shop-data', file: 'GUIDE.md' }), context);
    expect(loaded.content).toContain(`rulesSha256 ${digest()}`);
    expect(context.guidesDelivered?.['shop-data']).toMatchObject({ rulesSha256: digest(), full: true, whole: true });
    const reply = json(await chain().executeTool(call('knowledge_write', { ...EDIT, rulesSha256: digest() }), context));
    expect(reply).toMatchObject({ ok: true, status: 'applied' });
    const partial = h.turn(MESSAGE);
    await chain().executeTool(call('knowledge_load', { set: 'shop-data', file: 'GUIDE.md', lines: [1, 5] }), partial);
    expect(partial.guidesDelivered?.['shop-data']).toBeUndefined();
  });

  it('loading a non-guide library file marks the turn, which taints a GUIDE edit but not a content edit (P2-4)', async () => {
    const context = h.turn('add a guardrail to the shop-data guide: never store customer names');
    expect(context.knowledgeNonGuideLoaded).toBeUndefined();
    await chain().executeTool(call('knowledge_load', { set: 'shop-data', file: 'orders.md' }), context);
    expect(context.knowledgeNonGuideLoaded).toBe(true);
    const guideEdit = { set: 'shop-data', file: 'GUIDE.md', mode: 'append', content: '\n- Do NOT store customer names in any file\n', ownerRequested: true };
    await chain().executeTool(call('knowledge_load', { set: 'shop-data', file: 'GUIDE.md' }, 'g1'), context);
    const reply = json(await chain().executeTool(call('knowledge_write', { ...guideEdit, rulesSha256: digest() }), context));
    expect(reply).toMatchObject({ ok: true, status: 'staged', reason: expect.stringContaining('untrusted') });
    expect(h.read('shop-data/GUIDE.md')).not.toContain('customer names');
    // The same turn's content edit is not tainted by the load.
    const tainted = h.turn(MESSAGE, { knowledgeNonGuideLoaded: true });
    await chain().executeTool(call('knowledge_load', { set: 'shop-data', file: 'GUIDE.md' }, 'g2'), tainted);
    const content = json(await chain().executeTool(call('knowledge_write', { ...EDIT, rulesSha256: digest() }, 'w3'), tainted));
    expect(content).toMatchObject({ status: 'applied' });
  });

  it('a continuation may read and PROPOSE (a card, nothing written) but knowledge_write and knowledge_create_set are outside its mandate', async () => {
    const job = jobs.start({ goal: 'Summarize the shop reference' });
    const context: ToolExecutionContext = { currentUserMessage: job.goal, callerKind: 'continuation', jobMandate: { jobId: job.id, goal: job.goal } };
    const refused = json(await chain().executeTool(call('knowledge_write', EDIT), context));
    expect(refused).toMatchObject({ status: 'blocked', code: 'outside_job_mandate' });
    expect(json(await chain().executeTool(call('knowledge_create_set', { name: 'Bees', kind: 'research', description: 'Bees', ownerRequested: true }), context))).toMatchObject({ status: 'blocked', code: 'outside_job_mandate' });
    const proposal = { set: 'shop-data', file: 'orders.md', mode: 'edit', why: 'verified in a query', trigger: 'verified_fact', rulesSha256: digest(), edits: EDIT.edits };
    // A continuation holds no rules yet: its first proposal takes one guide_not_read round trip, then it stages a card.
    const { rulesSha256: withheld, ...askForRules } = proposal;
    expect(withheld).toBe(digest());
    expect(json(await chain().executeTool(call('knowledge_propose', askForRules, 'p0'), context))).toMatchObject({ code: 'guide_not_read', rulesSha256: digest() });
    const proposed = json(await chain().executeTool(call('knowledge_propose', proposal), context));
    expect(proposed).toMatchObject({ ok: true, status: 'staged', effect: 'staged' });
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
    expect(h.changes.get(proposed.changeId)).toMatchObject({ status: 'staged', origin: 'botboy_proposal' });
  });

  it('refusals and arguments that are not an object are structured, with a next action and no effect', async () => {
    const context = h.turn(MESSAGE);
    const bad = await chain().executeTool({ id: 'x', type: 'function', function: { name: 'knowledge_write', arguments: '{nope' } } as ToolCall, context);
    expect(json(bad)).toMatchObject({ ok: false, code: 'invalid_arguments', effect: 'none' });
    expect(bad.isError).toBe(true);
    const noOwner = json(await chain().executeTool(call('knowledge_write', { ...EDIT, ownerRequested: false, rulesSha256: digest() }), context));
    expect(noOwner).toMatchObject({ ok: false, code: 'owner_request_required', effect: 'none' });
    expect(noOwner.nextAction).toContain('knowledge_propose');
    const refusal = await chain().executeTool(call('knowledge_write', { ...EDIT, set: 'no-such-set', rulesSha256: digest() }), context);
    expect(refusal.isError).toBe(true);
  });

  it('logs a refusal as "[Knowledge] code set/file" and an applied change with its ids, never content', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const context = h.turn(MESSAGE);
    await chain().executeTool(call('knowledge_write', EDIT), context);
    expect(warn.mock.calls.map((args) => String(args[0]))).toContain('[Knowledge] guide_not_read shop-data/orders.md (knowledge_write)');
    await chain().executeTool(call('knowledge_write', { ...EDIT, rulesSha256: digest() }, 'w2'), context);
    const line = info.mock.calls.map((args) => String(args[0])).find((text) => text.startsWith('[Knowledge] applied'));
    expect(line).toMatch(/^\[Knowledge\] applied shop-data\/orders\.md \(knowledge_write\) change kc_[a-f0-9]{12} history h_/);
    expect(line).not.toContain('placeholders');
  });
});

describe('the O10 reinforcement in a set listing (the encouragement itself is in the knowledge_propose description)', () => {
  it('a guided set\'s listing ends with one sentence that says to propose at the END of the task', async () => {
    const listed = json(await chain().executeTool(call('knowledge_list', { set: 'shop-data' }), h.turn('what is in shop-data?')));
    expect(listed.note).toContain('Load one file whole with knowledge_load');
    expect(listed.note).toContain('propose it together with the rest at the end of the task (knowledge_propose)');
    expect(String(listed.note).length).toBeLessThan(260);
  });
});

/** Poll until `done` holds or `ms` has passed; the caller asserts on the result. */
const waitFor = async (done: () => boolean, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
};
describe('edits made outside BotBoy are noticed by a list or a read, beside it and never in front of it', () => {
  const withHistory = () => withJobMandate(withWorkplaceChatTools(withKnowledgeChatTools(base, { library: h.library, writer: h.writer, history: h.history }), {}), { jobs });

  it('a list or a load records a hand edit, after the first look has set the starting point', async () => {
    await withHistory().executeTool(call('knowledge_list'), h.turn('what do I have?'));
    // The notice is fire-and-forget: wait for the reconcile it started (a fixed 50 ms failed under a load average of 40).
    await waitFor(() => h.history.list().length >= 1);
    expect(h.history.list().map((entry) => entry.kind)).toEqual(['baseline']);
    h.put('shop-data/orders_analysis.md', '# Analysis\n\nEdited in an editor.\n');
    h.advance(5_000);
    await withHistory().executeTool(call('knowledge_load', { set: 'shop-data', file: 'orders.md' }), h.turn('open the orders reference'));
    await waitFor(() => h.history.list().length >= 2);
    expect(h.history.list()[0]).toMatchObject({ actor: 'outside', kind: 'outside', summary: expect.stringContaining('shop-data/orders_analysis.md') });
  }, 30_000);

  it('the read is answered even when History is stuck, and a failing History never fails a read', async () => {
    const hang = { ...h.history, reconcile: () => new Promise<never>(() => undefined) };
    const stuck = withJobMandate(withWorkplaceChatTools(withKnowledgeChatTools(base, { library: h.library, writer: h.writer, history: hang as never }), {}), { jobs });
    expect(json(await stuck.executeTool(call('knowledge_list'), h.turn('what do I have?')))).toMatchObject({ ok: true });
    const failing = withJobMandate(withWorkplaceChatTools(withKnowledgeChatTools(base, { library: h.library, writer: h.writer, history: { ...h.history, reconcile: async () => { throw new Error('boom'); } } as never }), {}), { jobs });
    expect(json(await failing.executeTool(call('knowledge_list'), h.turn('what do I have?')))).toMatchObject({ ok: true });
  });
});
