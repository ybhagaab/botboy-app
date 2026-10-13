import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  LEDGER_MAX_ENTRIES,
  RECOVERY_DROP_BLOCK_FIRST,
  SAME_MESSAGE_EDIT,
  STRIPPED_MAX_ENTRIES,
  TOOLS_MEMORY_MAX_ENTRIES,
  bodyHasThinking,
  createReplayGuard,
  messageHasThinking,
  thinkingBlockId,
  type ReplayGuard,
} from './anthropic-replay-guard.js';
import { deriveProfile, parseAnthropicModel } from './anthropic-models.js';
import { fakeModelRow } from './anthropic-api.fake.js';
import type { AnthropicBlock, AnthropicMessage, AnthropicTool } from './anthropic-messages.js';

/**
 * Design v3 D3 item 5 and banner item 3 (slice A2): the thinking replay guard. The rules under test: whole runs
 * only, a drop cascades through the running hash, a run produced after a drop is kept, hashes only, and the
 * guard enforces by MODEL (`prefixCheck`), never by account age.
 */
const tool = (name: string): AnthropicTool => ({ name, description: `${name} tool`, input_schema: { type: 'object', properties: {} } });
const TOOLS = [tool('read_file'), tool('write_file')];
const SYSTEM = 'You are BotBoy.';
const text = (value: string): AnthropicBlock => ({ type: 'text', text: value });
const thinking = (signature: string): AnthropicBlock => ({ type: 'thinking', thinking: '', signature });
const redacted = (data: string): AnthropicBlock => ({ type: 'redacted_thinking', data });
const use = (id: string): AnthropicBlock => ({ type: 'tool_use', id, name: 'read_file', input: { path: id } });
const result = (id: string, content: string): AnthropicBlock => ({ type: 'tool_result', tool_use_id: id, content });
const userMsg = (...content: AnthropicBlock[]): AnthropicMessage => ({ role: 'user', content });
const assistantMsg = (...content: AnthropicBlock[]): AnthropicMessage => ({ role: 'assistant', content });

/** A conversation that behaves like the API: BotBoy keeps the full history; each send goes through the guard and records the response. */
class Session {
  messages: AnthropicMessage[] = [userMsg(text('go'))];
  system = SYSTEM;
  tools: readonly AnthropicTool[] = TOOLS;
  edited: number[] = [];
  private counter = 0;
  constructor(readonly guard: ReplayGuard, private readonly enforce = true) {}

  send(...thinkingBlocks: AnthropicBlock[]) {
    const evaluation = this.guard.evaluate({ system: this.system, tools: this.tools, messages: this.messages, edited: this.edited, enforce: this.enforce });
    const id = `toolu_${(this.counter += 1)}`;
    const response = [...thinkingBlocks, use(id)];
    this.guard.record(evaluation, response);
    this.messages.push(assistantMsg(...response), userMsg(result(id, `result ${this.counter}`)));
    return evaluation;
  }

  evaluate() {
    return this.guard.evaluate({ system: this.system, tools: this.tools, messages: this.messages, edited: this.edited, enforce: this.enforce });
  }

  /** The pre-flight trim: shorten an earlier tool result. */
  trim(messageIndex: number) {
    const message = this.messages[messageIndex];
    this.messages[messageIndex] = { role: message.role, content: message.content.map(block => block.type === 'tool_result' ? { ...block, content: '[trimmed]' } : block) };
  }
}

const idsOf = (message: AnthropicMessage) => message.content.map(thinkingBlockId).filter(Boolean);

describe('replay guard: steady state and the constants', () => {
  it('pins the defaults the probe may later change', () => {
    expect(SAME_MESSAGE_EDIT).toBe('keep');
    expect(RECOVERY_DROP_BLOCK_FIRST).toBe(false);
    expect(createReplayGuard().sameMessageEdit).toBe('keep');
    expect(createReplayGuard().recoveryDropBlockFirst).toBe(false);
  });

  it('keeps every run, returns the same messages array and drops nothing when history is unchanged', () => {
    const session = new Session(createReplayGuard());
    session.send(thinking('sig-1'));
    session.send(thinking('sig-2'), redacted('blob-2'));
    session.send(thinking('sig-3'));
    const evaluation = session.evaluate();
    expect(evaluation.drops).toEqual([]);
    expect(evaluation.messages).toBe(session.messages);
    expect(evaluation.enforced).toBe(true);
  });

  it('tells redacted blocks apart by their data: two turns that each carry only a redacted block both stay', () => {
    const session = new Session(createReplayGuard());
    session.send(redacted('blob-1'));
    session.send(redacted('blob-2'));
    session.send(redacted('blob-3'));
    expect(session.evaluate().drops).toEqual([]);
    session.trim(2);
    expect(session.evaluate().drops.map(drop => drop.messageIndex)).toEqual([3, 5]);
  });

  it('ids are hashes of the signature or the redacted blob, never the content', () => {
    const id = thinkingBlockId(thinking('a-secret-looking-signature'))!;
    expect(id).toMatch(/^t:[0-9a-f]{64}$/);
    expect(id).not.toContain('secret');
    expect(thinkingBlockId(redacted('opaque'))).toMatch(/^r:[0-9a-f]{64}$/);
    expect(thinkingBlockId(text('hello'))).toBeUndefined();
    expect(messageHasThinking(assistantMsg(thinking('x'), text('y')))).toBe(true);
    expect(messageHasThinking(userMsg(text('y')))).toBe(false);
    expect(bodyHasThinking([userMsg(text('go')), assistantMsg(text('hi'))])).toBe(false);
  });
});

describe('replay guard: edits that change the checked prefix', () => {
  it('drops the runs after a trimmed earlier tool result (cascade) and keeps the run produced after the drop', () => {
    const session = new Session(createReplayGuard());
    session.send(thinking('sig-1'));
    session.send(thinking('sig-2'));
    session.send(thinking('sig-3'));
    session.trim(2); // the first tool result, as the pre-flight trim does
    const afterTrim = session.send(thinking('sig-4'));
    // Messages: 0 user, 1 assistant(sig-1), 2 result, 3 assistant(sig-2), 4 result, 5 assistant(sig-3), 6 result.
    expect(afterTrim.drops).toEqual([
      { messageIndex: 3, blocks: 1, cause: 'messages' },
      { messageIndex: 5, blocks: 1, cause: 'messages' },
    ]);
    // The run before the edit stays; the sent copy lost only the dropped runs.
    expect(afterTrim.messages[1].content.some(block => block.type === 'thinking')).toBe(true);
    expect(afterTrim.messages[3].content.map(block => block.type)).toEqual(['tool_use']);
    expect(afterTrim.messages[5].content.map(block => block.type)).toEqual(['tool_use']);
    // BotBoy's own history still holds everything.
    expect(session.messages[3].content.map(block => block.type)).toEqual(['thinking', 'tool_use']);
    // The next request: the old runs stay dropped, the one produced against the post-drop body is kept.
    const next = session.evaluate();
    expect(next.drops.map(drop => drop.messageIndex)).toEqual([3, 5]);
    expect(next.messages[7].content.some(block => block.type === 'thinking')).toBe(true);
  });

  it('cascades through the running hash: stripping ONE earlier run drops every later run recorded on top of it', () => {
    const guard = createReplayGuard();
    const session = new Session(guard);
    session.send(thinking('sig-1'));
    session.send(thinking('sig-2'));
    session.send(thinking('sig-3'));
    guard.stripAll([session.messages[3]]); // only the second run
    const evaluation = session.evaluate();
    expect(evaluation.drops).toEqual([
      { messageIndex: 3, blocks: 1, cause: 'stripped' },
      { messageIndex: 5, blocks: 1, cause: 'messages' },
    ]);
    expect(evaluation.messages[1].content.some(block => block.type === 'thinking')).toBe(true);
  });

  it('names the cause: a changed tools array, a changed system prompt, or an edited message', () => {
    const toolsSession = new Session(createReplayGuard());
    toolsSession.send(thinking('sig-1'));
    toolsSession.send(thinking('sig-2'));
    toolsSession.tools = [tool('read_file'), tool('write_file'), tool('new_tool')];
    expect(toolsSession.evaluate().drops).toEqual([
      { messageIndex: 1, blocks: 1, cause: 'tools' },
      { messageIndex: 3, blocks: 1, cause: 'tools' },
    ]);
    // Back to the real tools: the runs produced under them match again.
    toolsSession.tools = TOOLS;
    expect(toolsSession.evaluate().drops).toEqual([]);

    const systemSession = new Session(createReplayGuard());
    systemSession.send(thinking('sig-1'));
    systemSession.system = 'A different system prompt.';
    expect(systemSession.evaluate().drops).toEqual([{ messageIndex: 1, blocks: 1, cause: 'system' }]);
  });

  it('a run produced under stub tools is dropped when the real tools come back (its prefix held the stubs)', () => {
    const guard = createReplayGuard();
    const session = new Session(guard);
    session.send(thinking('sig-1'));
    session.tools = guard.resolveWithheld(['unknown_tool']);
    session.send(thinking('sig-2'));
    session.tools = TOOLS;
    const evaluation = session.evaluate();
    expect(evaluation.drops).toEqual([{ messageIndex: 3, blocks: 1, cause: 'tools' }]);
    expect(evaluation.messages[1].content.some(block => block.type === 'thinking')).toBe(true);
  });

  it('treats a replaced image like any other earlier edit (screenshot supersede)', () => {
    const guard = createReplayGuard();
    const session = new Session(guard);
    const screenshot = userMsg(
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      text('Browser screenshot evidence.'),
    );
    session.messages.push(assistantMsg(text('looking')), screenshot);
    session.send(thinking('sig-1'));
    session.messages[2] = userMsg(text('Browser screenshot k1 was superseded by a newer capture.'));
    expect(session.evaluate().drops).toEqual([{ messageIndex: 3, blocks: 1, cause: 'messages' }]);
  });

  it('is insensitive to key order in tools and blocks (one canonical serialization)', () => {
    const guard = createReplayGuard();
    const session = new Session(guard);
    session.send(thinking('sig-1'));
    session.tools = [
      { input_schema: { properties: {}, type: 'object' }, description: 'read_file tool', name: 'read_file' },
      { description: 'write_file tool', name: 'write_file', input_schema: { type: 'object', properties: {} } },
    ];
    expect(session.evaluate().drops).toEqual([]);
  });
});

describe('replay guard: whole runs only, never part of one', () => {
  it('drops every thinking block of a message together, including a block the ledger does not know', () => {
    const guard = createReplayGuard();
    const session = new Session(guard);
    session.send(thinking('sig-1'));
    session.send(thinking('sig-2'), redacted('blob-2'));
    session.trim(2);
    // A foreign block joins a known run (another process wrote it, or its ledger entry was evicted).
    session.messages[3] = assistantMsg(thinking('foreign'), ...session.messages[3].content);
    const evaluation = session.evaluate();
    // The message is judged by its known ids (mismatched), and the whole run goes: 3 blocks, not 2.
    expect(evaluation.drops).toEqual([{ messageIndex: 3, blocks: 3, cause: 'messages' }]);
    for (const [index, message] of evaluation.messages.entries()) {
      const before = idsOf(session.messages[index]);
      const after = idsOf(message);
      expect(after.length === 0 || after.length === before.length, `message ${index}`).toBe(true);
    }
  });

  it('keeps a whole message when its known ids match, whatever its unknown ids are', () => {
    const guard = createReplayGuard();
    const session = new Session(guard);
    session.send(thinking('sig-1'));
    // A foreign block (never recorded: another process, or evicted) sits beside a known matching one.
    session.messages[1] = assistantMsg(thinking('sig-1'), thinking('foreign'), use('toolu_1'));
    expect(session.evaluate().drops).toEqual([]);
  });

  it('passes unknown ids through (an evicted ledger entry reads as kept)', () => {
    const guard = createReplayGuard();
    const session = new Session(guard);
    session.send(thinking('sig-1'));
    for (let index = 0; index < LEDGER_MAX_ENTRIES + 10; index += 1) {
      guard.record({ messages: [], drops: [], prefix: `p${index}`, systemDigest: 's', toolsDigest: 't', enforced: true, editedKept: [] }, [thinking(`filler-${index}`)]);
    }
    expect(guard.sizes.ledger).toBe(LEDGER_MAX_ENTRIES);
    session.trim(2);
    // sig-1 was evicted, so even an edited history cannot be judged: it passes through.
    expect(session.evaluate().drops).toEqual([]);
  });

  it('property: no assistant message ever loses only some of its thinking blocks, across generated sessions and edits', () => {
    const operation = fc.oneof(
      fc.record({ kind: fc.constant('turn' as const), thinking: fc.integer({ min: 0, max: 3 }), redacted: fc.boolean() }),
      fc.record({ kind: fc.constant('trim' as const), pick: fc.nat(40) }),
      fc.record({ kind: fc.constant('tools' as const), extra: fc.boolean() }),
      fc.record({ kind: fc.constant('system' as const), variant: fc.integer({ min: 0, max: 2 }) }),
      fc.record({ kind: fc.constant('foreign' as const), pick: fc.nat(40) }),
      fc.record({ kind: fc.constant('strip' as const), pick: fc.nat(40) }),
      fc.record({ kind: fc.constant('edited' as const), pick: fc.nat(40) }),
    );
    fc.assert(
      fc.property(fc.array(operation, { minLength: 1, maxLength: 24 }), fc.constantFrom('keep' as const, 'drop_run' as const), (operations, mode) => {
        const guard = createReplayGuard({ sameMessageEdit: mode });
        const session = new Session(guard);
        let serial = 0;
        for (const step of operations) {
          const assistantIndexes = session.messages.map((message, index) => (message.role === 'assistant' ? index : -1)).filter(index => index >= 0);
          const resultIndexes = assistantIndexes.map(index => index + 1);
          if (step.kind === 'turn') {
            const blocks: AnthropicBlock[] = Array.from({ length: step.thinking }, () => thinking(`sig-${(serial += 1)}`));
            if (step.redacted) blocks.push(redacted(`blob-${(serial += 1)}`));
            session.send(...blocks);
          } else if (step.kind === 'trim' && resultIndexes.length) {
            session.trim(resultIndexes[step.pick % resultIndexes.length]);
          } else if (step.kind === 'tools') {
            session.tools = step.extra ? [...TOOLS, tool('extra')] : TOOLS;
          } else if (step.kind === 'system') {
            session.system = `${SYSTEM} v${step.variant}`;
          } else if (step.kind === 'foreign' && assistantIndexes.length) {
            const index = assistantIndexes[step.pick % assistantIndexes.length];
            session.messages[index] = assistantMsg(thinking(`foreign-${(serial += 1)}`), ...session.messages[index].content);
          } else if (step.kind === 'strip' && assistantIndexes.length) {
            guard.stripAll([session.messages[assistantIndexes[step.pick % assistantIndexes.length]]]);
          } else if (step.kind === 'edited' && assistantIndexes.length) {
            session.edited = [assistantIndexes[step.pick % assistantIndexes.length]];
          }
          const evaluation = session.evaluate();
          evaluation.messages.forEach((message, index) => {
            const before = idsOf(session.messages[index]).length;
            const after = idsOf(message).length;
            if (after !== 0 && after !== before) throw new Error(`message ${index} kept ${after} of ${before} thinking blocks`);
          });
          for (const drop of evaluation.drops) {
            if (drop.blocks !== idsOf(session.messages[drop.messageIndex]).length) throw new Error('a drop must name the whole run');
          }
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

describe('replay guard: same-message edits (SAME_MESSAGE_EDIT)', () => {
  const edited = (mode?: 'keep' | 'drop_run') => {
    const session = new Session(createReplayGuard(mode ? { sameMessageEdit: mode } : {}));
    session.send(thinking('sig-1'), thinking('sig-1b'));
    session.edited = [1]; // chat compacted a tool_use input in this very message
    return session;
  };

  it("'keep' (the default) replays the message's thinking as returned and reports the edit for the log line", () => {
    const evaluation = edited().evaluate();
    expect(evaluation.drops).toEqual([]);
    expect(evaluation.editedKept).toEqual([1]);
  });

  it("'drop_run' drops that message's whole run, never part of it", () => {
    const evaluation = edited('drop_run').evaluate();
    expect(evaluation.drops).toEqual([{ messageIndex: 1, blocks: 2, cause: 'edited' }]);
    expect(evaluation.editedKept).toEqual([]);
  });

  it('an edit flag on a message without thinking changes nothing', () => {
    const session = new Session(createReplayGuard({ sameMessageEdit: 'drop_run' }));
    session.send();
    session.edited = [1];
    expect(session.evaluate().drops).toEqual([]);
  });
});

describe('replay guard: enforcement follows the model, not the account', () => {
  const profile = (id: string, variant: 'A' | 'B' | 'C') => deriveProfile(parseAnthropicModel(fakeModelRow({ id, variant }))!);

  it('enforces on the models that run the prefix check and on unknown adaptive ids; not on the rest', () => {
    expect(profile('claude-sonnet-5-5', 'A').prefixCheck).toBe(true);
    expect(profile('claude-haiku-5-5', 'B').prefixCheck).toBe(true);
    expect(profile('claude-future-adaptive-9', 'A').prefixCheck).toBe(true);
    expect(profile('claude-opus-5', 'B').prefixCheck).toBe(false);
    expect(profile('claude-mythos-5-1', 'A').prefixCheck).toBe(false);
    expect(profile('claude-opus-4-5-20251101', 'C').prefixCheck).toBe(false);
  });

  it('with enforce off, a block the API itself rejected earlier still stays out (the strip-all recovery applies to any model)', () => {
    const guard = createReplayGuard();
    const session = new Session(guard, false);
    session.send(thinking('sig-1'));
    session.send(thinking('sig-2'));
    guard.stripAll([session.messages[1]]);
    const evaluation = session.evaluate();
    expect(evaluation.drops).toEqual([{ messageIndex: 1, blocks: 1, cause: 'stripped' }]);
    expect(evaluation.messages[1].content.map(block => block.type)).toEqual(['tool_use']);
    expect(evaluation.messages[3].content.map(block => block.type)).toEqual(['thinking', 'tool_use']);
    expect(evaluation.enforced).toBe(false);
  });

  it('with enforce off, history is replayed as is, nothing is recorded and nothing is dropped', () => {
    const guard = createReplayGuard();
    const session = new Session(guard, false);
    session.send(thinking('sig-1'));
    session.send(thinking('sig-2'));
    session.trim(2);
    session.tools = [tool('other')];
    session.system = 'changed';
    const evaluation = session.evaluate();
    expect(evaluation.drops).toEqual([]);
    expect(evaluation.messages).toBe(session.messages);
    expect(evaluation.enforced).toBe(false);
    expect(guard.sizes.ledger).toBe(0);
  });
});

describe('replay guard: recovery state (the two documented 400s)', () => {
  it('forgets every thinking block of the sent body for good, and a run produced afterwards is kept', () => {
    const guard = createReplayGuard();
    const session = new Session(guard);
    session.send(thinking('sig-1'));
    session.send(thinking('sig-2'), redacted('blob-2'));
    expect(guard.stripAll(session.messages)).toBe(3);
    expect(guard.stripAll(session.messages)).toBe(0);
    const evaluation = session.send(thinking('sig-3'));
    expect(evaluation.drops).toEqual([
      { messageIndex: 1, blocks: 1, cause: 'stripped' },
      { messageIndex: 3, blocks: 2, cause: 'stripped' },
    ]);
    const next = session.evaluate();
    expect(next.drops.map(drop => drop.messageIndex)).toEqual([1, 3]);
    expect(next.messages[5].content.some(block => block.type === 'thinking')).toBe(true);
  });

  it('bounds the stripped set', () => {
    const guard = createReplayGuard();
    const messages = Array.from({ length: STRIPPED_MAX_ENTRIES + 50 }, (_, index) => assistantMsg(thinking(`s${index}`), text('x')));
    guard.stripAll(messages);
    expect(guard.sizes.stripped).toBe(STRIPPED_MAX_ENTRIES);
  });
});

describe('replay guard: the withheld-tools memory (L12)', () => {
  it('re-sends the most recent remembered array that defines every tool name the history uses', () => {
    const guard = createReplayGuard();
    const chatTools = [tool('read_file'), tool('write_file'), tool('chat_only')];
    const agentTools = [tool('read_file'), tool('agent_only')];
    guard.remember(chatTools);
    guard.remember(agentTools);
    expect(guard.resolveWithheld(['read_file'])).toEqual(agentTools);
    expect(guard.resolveWithheld(['read_file', 'chat_only'])).toEqual(chatTools);
    expect(guard.resolveWithheld(['agent_only'])).toEqual(agentTools);
    // A refreshed entry becomes the most recent again.
    guard.remember(chatTools);
    expect(guard.resolveWithheld(['read_file'])).toEqual(chatTools);
  });

  it('falls back to stubs for every name seen, sorted, when no entry defines them all', () => {
    const guard = createReplayGuard();
    guard.remember([tool('read_file')]);
    const stubs = guard.resolveWithheld(['zeta', 'alpha', 'read_file']);
    expect(stubs.map(entry => entry.name)).toEqual(['alpha', 'read_file', 'zeta']);
    expect(stubs[0].input_schema).toEqual({ type: 'object', properties: {} });
    expect(createReplayGuard().resolveWithheld(['a']).map(entry => entry.name)).toEqual(['a']);
  });

  it('keeps at most 8 tool sets, evicting the least recently used', () => {
    const guard = createReplayGuard();
    for (let index = 0; index < TOOLS_MEMORY_MAX_ENTRIES + 1; index += 1) guard.remember([tool(`only_${index}`)]);
    expect(guard.sizes.toolSets).toBe(TOOLS_MEMORY_MAX_ENTRIES);
    // The first set is gone: its name now resolves to a stub, the latest still to the real array.
    expect(guard.resolveWithheld(['only_0'])[0].description).toBe('(Unavailable in this step.)');
    expect(guard.resolveWithheld(['only_8'])[0].description).toBe('only_8 tool');
  });

  it('a stub fallback changes the checked tools, so the guard drops earlier thinking with it', () => {
    const guard = createReplayGuard();
    const session = new Session(guard);
    session.send(thinking('sig-1'));
    session.tools = guard.resolveWithheld(['read_file', 'never_remembered']);
    expect(session.evaluate().drops).toEqual([{ messageIndex: 1, blocks: 1, cause: 'tools' }]);
  });
});
