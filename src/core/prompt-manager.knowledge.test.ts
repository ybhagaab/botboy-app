/**
 * The library in the chat prompt (knowledge-library.md K7, K9; design amendment P2-6): zero tokens and zero tool
 * definitions until the owner creates the library; then two small definitions and, per turn, one block placed just before
 * the active job. Figures are asserted as numbers and recorded in the phase report.
 */
import { describe, expect, it } from 'vitest';
import { estimateTokens } from './knowledge-guide.js';
import { createPromptManager, type AgentRole } from './prompt-manager.js';

const manager = createPromptManager();
const namesOf = (role: AgentRole, context?: Parameters<typeof manager.getToolDefinitions>[1]) => manager.getToolDefinitions(role, context).map((tool) => tool.function.name);
const sizeOf = (name: string, context: { knowledgeAvailable: boolean; knowledgeWriteAvailable?: boolean } = { knowledgeAvailable: true }) => {
  const definition = manager.getToolDefinitions('chat', context).find((tool) => tool.function.name === name);
  return estimateTokens(JSON.stringify(definition));
};

describe('tool definitions', () => {
  it('offers no library tool until the library exists (zero resident cost), whatever the write flag says', () => {
    for (const context of [undefined, {}, { knowledgeAvailable: false }, { knowledgeAvailable: false, knowledgeWriteAvailable: true }]) {
      expect(namesOf('chat', context).filter((name) => name.startsWith('knowledge_')), JSON.stringify(context)).toEqual([]);
    }
  });
  it('offers the two reads and the proposal once the library exists, the write tools only on a turn with a write intent, and nothing to any other role', () => {
    const reads = ['knowledge_list', 'knowledge_load', 'knowledge_propose'];
    expect(namesOf('chat', { knowledgeAvailable: true }).filter((name) => name.startsWith('knowledge_'))).toEqual(reads);
    expect(namesOf('chat', { knowledgeAvailable: true, knowledgeWriteAvailable: false }).filter((name) => name.startsWith('knowledge_'))).toEqual(reads);
    expect(namesOf('chat', { knowledgeAvailable: true, knowledgeWriteAvailable: true }).filter((name) => name.startsWith('knowledge_'))).toEqual([...reads, 'knowledge_write', 'knowledge_create_set']);
    for (const role of ['orchestrator', 'classifier', 'enricher', 'organizer', 'describer', 'deduplicator', 'product_manager'] as AgentRole[]) {
      expect(namesOf(role, { knowledgeAvailable: true, knowledgeWriteAvailable: true }).some((name) => name.startsWith('knowledge_')), role).toBe(false);
    }
  });
  it('changes nothing else: the rest of the chat toolset is the same with and without the library', () => {
    const without = namesOf('chat', {});
    expect(namesOf('chat', { knowledgeAvailable: true }).filter((name) => !name.startsWith('knowledge_'))).toEqual(without);
    expect(namesOf('chat', { knowledgeAvailable: true, knowledgeWriteAvailable: true }).filter((name) => !name.startsWith('knowledge_'))).toEqual(without);
  });
  it('keeps the pair at or below 400 estimated tokens, the proposal-and-write trio at or below 1,400 and the whole family at or below 1,800 (recorded)', () => {
    const all = { knowledgeAvailable: true, knowledgeWriteAvailable: true };
    const list = sizeOf('knowledge_list', all);
    const load = sizeOf('knowledge_load', all);
    const propose = sizeOf('knowledge_propose', all);
    const write = sizeOf('knowledge_write', all);
    const create = sizeOf('knowledge_create_set', all);
    // The numbers are printed so the report can quote them.
    console.log(`[knowledge tool definitions] list=${list} load=${load} propose=${propose} write=${write} create_set=${create} pair=${list + load} trio=${propose + write + create} family=${list + load + propose + write + create} ordinary_turn=${list + load + propose} estimated tokens`);
    expect(list).toBeLessThanOrEqual(160);
    expect(load).toBeLessThanOrEqual(260);
    expect(list + load).toBeLessThanOrEqual(400);
    expect(propose + write + create).toBeLessThanOrEqual(1_400);
    expect(list + load + propose + write + create).toBeLessThanOrEqual(1_800);
    // What an ordinary turn pays: the pair plus the proposal (the write tools ride only on a write intent).
    expect(list + load + propose).toBeLessThanOrEqual(1_000);
  });
  it('puts the O10 encouragement where every activated turn sees it: the proposal tool says what to look for, to group at the END, one call per file, and what to skip', () => {
    const description = manager.getToolDefinitions('chat', { knowledgeAvailable: true }).find((tool) => tool.function.name === 'knowledge_propose')!.function.description;
    expect(description).toMatch(/worth keeping/);
    for (const trigger of ['verified fact', 'owner correction', 'new column or event', 'failure you worked around']) expect(description).toContain(trigger);
    expect(description).toMatch(/together at the END of the task, one call per file/);
    expect(description).toMatch(/skip anything transient, unverified or already in the guide/);
    expect(description).toMatch(/propose_lesson/);
    expect(description).toMatch(/never instructions/);
  });
  it('the write tools act only on the owner\'s exact request, and the proposal never claims to apply anything', () => {
    const defs = manager.getToolDefinitions('chat', { knowledgeAvailable: true, knowledgeWriteAvailable: true });
    expect(defs.find((tool) => tool.function.name === 'knowledge_write')!.function.description).toMatch(/owner asked for exactly this edit/);
    expect(defs.find((tool) => tool.function.name === 'knowledge_propose')!.function.description).toMatch(/you never apply it/);
    expect((defs.find((tool) => tool.function.name === 'knowledge_write')!.function.parameters as { required: string[] }).required).toContain('ownerRequested');
    expect((defs.find((tool) => tool.function.name === 'knowledge_propose')!.function.parameters as { required: string[] }).required).not.toContain('ownerRequested');
  });
  it('describes each tool in a way that routes: when to call it, and what a too-big file does', () => {
    const definitions = manager.getToolDefinitions('chat', { knowledgeAvailable: true });
    const list = definitions.find((tool) => tool.function.name === 'knowledge_list')!;
    const load = definitions.find((tool) => tool.function.name === 'knowledge_load')!;
    expect(list.function.description).toMatch(/before SQL, ETL or product work/);
    expect(load.function.description).toMatch(/sql-context down/);
    expect(load.function.description).toMatch(/outline/);
    expect((load.function.parameters as { required: string[] }).required).toEqual(['set', 'file']);
  });
});

describe('the system prompt', () => {
  const base = () => manager.getSystemPrompt('chat', {});

  it('is byte-identical without a library block, whatever the availability flag says', () => {
    expect(manager.getSystemPrompt('chat', { knowledgeAvailable: true })).toBe(base());
    expect(manager.getSystemPrompt('chat', { knowledgeAvailable: false })).toBe(base());
  });

  it('adds the block after the Drive guidance and just BEFORE the active job, which stays last', () => {
    const block = 'Knowledge library: shop-data. knowledge_list / knowledge_load read it; commands cannot change it.';
    const job = '## ACTIVE JOB\nThe owner asked for this.';
    const prompt = manager.getSystemPrompt('chat', { knowledgeBlock: block, jobBlock: job, driveConnected: true });
    const at = (needle: string) => prompt.indexOf(needle);
    expect(at('## Google Drive')).toBeGreaterThan(0);
    expect(at(block)).toBeGreaterThan(at('## Google Drive'));
    expect(at(job)).toBeGreaterThan(at(block));
    expect(prompt.endsWith(job)).toBe(true);
    expect(prompt.endsWith(`${block}`)).toBe(false);
    expect(manager.getSystemPrompt('chat', { knowledgeBlock: block }).endsWith(block)).toBe(true);
  });

  it('puts the block in the chat prompt only', () => {
    expect(manager.getSystemPrompt('orchestrator', { knowledgeBlock: 'Knowledge library: x.' })).not.toContain('Knowledge library: x.');
    expect(manager.getSystemPrompt('product_manager', { knowledgeBlock: 'Knowledge library: x.' })).not.toContain('Knowledge library: x.');
  });

  it('never edits an existing paragraph: the Amazon-off prompt edits still apply to the same text', () => {
    const off = manager.getSystemPrompt('chat', { amazonEmployee: false, knowledgeBlock: 'Knowledge library: x.' });
    expect(off.endsWith('Knowledge library: x.')).toBe(true);
    expect(manager.getSystemPrompt('chat', { amazonEmployee: false })).toBe(off.slice(0, off.length - '\n\nKnowledge library: x.'.length));
  });
});
