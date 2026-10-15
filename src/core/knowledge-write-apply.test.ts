/**
 * The owner's click and everything that can go wrong around an apply (knowledge-library.md K17): only the stored candidate
 * is written; guide-check items can be overridden but secrets and the deterministic gates never; untrusted-derived text
 * needs a second click; stale bases and edited rules make a change stale; a failing write rolls back; a permission refusal
 * is reported with its next action; outside edits are found; two writers cannot both win. Hermetic, synthetic.
 */
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrivateKeyBlock, guideWith } from './knowledge-fixtures.testutil.js';
import { noteToolCall } from './knowledge-taint.js';
import { dateBreach, makeHarness, type Harness } from './knowledge-write.testutil.js';
import type { LlmClient } from './llm-client.js';

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(() => { vi.restoreAllMocks(); h.close(); fs.rmSync(h.base, { recursive: true, force: true }); });

const ADD = { set: 'shop-data', file: 'orders.md', mode: 'edit', edits: [{ find: '- Always filter by channel.', replace: '- Always filter by channel.\n- Use placeholders for dates.' }] };
const PROPOSE = { why: 'verified in a real query', trigger: 'verified_fact' as const };
const proposal = async (args: Record<string, unknown> = ADD, context = h.turn('continue the job', { callerKind: 'continuation', ownerRequestId: undefined })) =>
  h.write(context, { ...args, ...PROPOSE }, 'knowledge_propose');

describe('Apply on a card', () => {
  it('writes exactly the stored candidate, records the owner as the actor, and closes the change', async () => {
    const staged = await proposal();
    expect(staged.status).toBe('staged');
    const stored = h.changes.get(String(staged.changeId))?.plan?.files[0].after;
    const result = await h.writer.apply(String(staged.changeId));
    expect(result).toMatchObject({ ok: true, summary: expect.stringContaining('edit orders.md') });
    expect(h.read('shop-data/orders.md')).toBe(stored);
    expect(h.history.list()[0]).toMatchObject({ actor: 'owner-via-botboy', kind: 'write', changeId: staged.changeId });
    expect(h.changes.get(String(staged.changeId))).toMatchObject({ status: 'applied', plan: null });
    expect(await h.writer.apply(String(staged.changeId))).toMatchObject({ ok: false, code: 'change_closed' });
  });

  it('has no argument that carries content: a body at click time changes nothing', async () => {
    const staged = await proposal();
    await h.writer.apply(String(staged.changeId), { anyway: true, confirmFlagged: true, ...({ content: 'INJECTED', edits: [{ find: 'a', replace: 'b' }] } as object) } as never);
    expect(h.read('shop-data/orders.md')).not.toContain('INJECTED');
    expect(h.read('shop-data/orders.md')).toContain('Use placeholders for dates.');
  });

  it('an unknown or malformed id is not found; dismiss closes a change and keeps it from applying', async () => {
    expect(await h.writer.apply('kc_000000000000')).toMatchObject({ ok: false, code: 'change_not_found', status: 404 });
    expect(await h.writer.apply('nope')).toMatchObject({ ok: false, code: 'change_not_found' });
    const staged = await proposal();
    expect(h.writer.dismiss(String(staged.changeId))).toMatchObject({ status: 'dismissed', plan: null });
    expect(await h.writer.apply(String(staged.changeId))).toMatchObject({ ok: false, code: 'change_closed' });
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
    expect(h.writer.dismiss('kc_000000000000')).toBeNull();
  });
});

describe('Apply anyway (the owner stays the authority over their guides)', () => {
  const breachLine = 'For the 2026-03-14 campaign use the legacy filter.';
  const breach = { ...ADD, edits: [{ find: '- Always filter by channel.', replace: `- Always filter by channel.\n- ${breachLine}` }] };
  async function stagedWithOpenItems() {
    h.queue({ items: [dateBreach(breachLine), { tier: 'should_fix', problem: 'Name the filter.', fix: 'Say which one.' }] });
    return h.write(h.turn('please add a note to shop-data orders.md'), { ...breach, stageAsIs: true });
  }

  it('needs the explicit anyway, then writes the stored candidate and records what was overridden', async () => {
    const staged = await stagedWithOpenItems();
    expect(staged).toMatchObject({ status: 'staged', unresolved: [{ tier: 'must_fix' }, { tier: 'should_fix' }] });
    expect(await h.writer.apply(String(staged.changeId))).toMatchObject({ ok: false, code: 'needs_anyway', status: 409 });
    expect(h.read('shop-data/orders.md')).not.toContain('2026-03-14');
    const result = await h.writer.apply(String(staged.changeId), { anyway: true });
    expect(result).toMatchObject({ ok: true });
    expect(h.read('shop-data/orders.md')).toContain(breachLine);
    const entry = h.history.list()[0];
    expect(entry.overrode).toEqual([expect.stringContaining('must_fix: Do NOT add hardcoded dates')]);
    expect(entry.checkNotes?.map((note) => note.tier)).toEqual(['should_fix']);
    expect(h.changes.get(String(staged.changeId))?.overrode).toHaveLength(1);
  });

  it('never overrides a secret format: a code-made item cannot be applied anyway, and neither can text that holds one', async () => {
    const reply = await h.write(h.turn('please add a note to shop-data orders.md'), { set: 'shop-data', file: 'creds.md', mode: 'create', content: `# Notes\n\n${fakePrivateKeyBlock()}\n`, stageAsIs: true });
    expect(reply).toMatchObject({ status: 'staged' });
    expect(await h.writer.apply(String(reply.changeId), { anyway: true, confirmFlagged: true })).toMatchObject({ ok: false, code: 'secret_in_content', status: 409 });
    expect(h.exists('shop-data/creds.md')).toBe(false);
    // Even a plan that was altered after staging is scanned at apply.
    const staged = await proposal();
    const row = h.changes.get(String(staged.changeId))!;
    h.changes.update(row.id, { plan: { ...row.plan!, files: [{ ...row.plan!.files[0], after: `${row.plan!.files[0].after}\n${fakePrivateKeyBlock()}\n` }] } });
    expect(await h.writer.apply(row.id, { anyway: true, confirmFlagged: true })).toMatchObject({ ok: false, code: 'secret_in_content' });
  });

  it('text derived from untrusted content shows its sources and needs a second, confirming click', async () => {
    const context = h.turn('please add a note to shop-data orders.md');
    noteToolCall(context, 'gmail_read');
    const staged = await h.write(context, ADD);
    expect(staged).toMatchObject({ status: 'staged' });
    expect(await h.writer.apply(String(staged.changeId))).toMatchObject({ ok: false, code: 'confirm_required', message: expect.stringContaining('email') });
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
    const confirmed = await h.writer.apply(String(staged.changeId), { confirmFlagged: true });
    expect(confirmed).toMatchObject({ ok: true });
    expect(h.history.list()[0]).toMatchObject({ sources: ['email'] });
  });

  it('a suspicious-directive card needs the confirming click too', async () => {
    h.queue({ suspiciousDirective: true });
    const staged = await h.write(h.turn('please add a note to shop-data orders.md'), ADD);
    expect(await h.writer.apply(String(staged.changeId))).toMatchObject({ code: 'confirm_required', message: expect.stringContaining('instructions to an assistant') });
    expect(await h.writer.apply(String(staged.changeId), { confirmFlagged: true })).toMatchObject({ ok: true });
  });
});

describe('the deterministic gates never bend, for the click too', () => {
  it('a set that became read-only after staging cannot be written by an Apply', async () => {
    const staged = await proposal();
    h.put('shop-data/GUIDE.md', fs.readFileSync(h.abs('shop-data/GUIDE.md'), 'utf8').replace(/^/, '---\nname: shop-data\nwritable: no\n---\n'));
    // The guide changed on disk (also a hand edit of the file), so the change is stale or refused; either way nothing is written.
    const result = await h.writer.apply(String(staged.changeId));
    expect(result.ok).toBe(false);
    expect(['read_only_set', 'stale_base']).toContain((result as { code: string }).code);
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
  });

  it('a file that changed after staging makes the change stale, with Re-draft as the way out', async () => {
    const staged = await proposal();
    h.put('shop-data/orders.md', `${h.read('shop-data/orders.md')}\n- The owner added this in an editor.\n`);
    const result = await h.writer.apply(String(staged.changeId));
    expect(result).toMatchObject({ ok: false, code: 'stale_base', status: 409, nextAction: expect.stringContaining('Re-draft') });
    expect(h.changes.get(String(staged.changeId))).toMatchObject({ status: 'stale' });
    expect(h.read('shop-data/orders.md')).toContain('The owner added this');
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
    expect(await h.writer.apply(String(staged.changeId))).toMatchObject({ ok: false, code: 'stale_base' });
  });

  it('a hand edit of a rule after staging makes the change stale (rules_changed)', async () => {
    const staged = await proposal();
    h.put('shop-data/GUIDE.md', fs.readFileSync(h.abs('shop-data/GUIDE.md'), 'utf8').replace('Do NOT add hardcoded dates', 'It is fine to add hardcoded dates'));
    const result = await h.writer.apply(String(staged.changeId));
    expect(result).toMatchObject({ ok: false, code: 'stale_base' });
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
  });

  it('held and revising changes cannot be applied', async () => {
    h.setClient(null);
    const held = await h.write(h.turn('please add a note to shop-data orders.md'), ADD);
    expect(await h.writer.apply(String(held.changeId))).toMatchObject({ ok: false, code: 'held_check_unavailable', status: 409 });
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
  });
});

describe('R7: the click is decided under the lock', () => {
  it('two Apply clicks on one card apply it once; the second answers change_closed and the change stays applied', async () => {
    const staged = await proposal();
    const id = String(staged.changeId);
    const [first, second] = await Promise.all([h.writer.apply(id), h.writer.apply(id)]);
    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].find((result) => !result.ok)).toMatchObject({ ok: false, code: 'change_closed' });
    expect(h.changes.get(id)?.status).toBe('applied');
    expect(h.history.list().filter((entry) => entry.kind === 'write')).toHaveLength(1);
    expect(h.read('shop-data/orders.md').match(/Use placeholders for dates\./g)).toHaveLength(1);
  });
});

describe('R9: the click holds a change to the same gates the plan passed', () => {
  const forged = (file: string, after: string) => h.changes.insert({
    setName: 'shop-data', kind: 'write', mode: 'create', file,
    plan: { mode: 'create', set: 'shop-data', file, files: [{ path: `shop-data/${file}`, before: null, after }], summary: `create ${file}` },
    baseSha256: null, rulesSha256: '', diffText: '', why: '', trigger: null, origin: 'botboy_proposal', sources: [], candidateSha256: 'x'.repeat(64), status: 'staged',
  });

  it('a .json file in a set whose guide does not declare writeTypes: json is refused at the click, as at planning', async () => {
    const row = forged('config.json', '{"a": 1}');
    expect(await h.writer.apply(row.id)).toMatchObject({ ok: false, code: 'unsupported_type', status: 409 });
    expect(h.exists('shop-data/config.json')).toBe(false);
  });

  it('where the guide declares json, the text must still parse at the click; valid json applies', async () => {
    h.put('shop-data/GUIDE.md', guideWith({ name: 'shop-data', writeTypes: 'json' }, fs.readFileSync(h.abs('shop-data/GUIDE.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '')));
    expect(await h.writer.apply(forged('bad.json', '{ not json').id)).toMatchObject({ ok: false, code: 'invalid_json' });
    expect(h.exists('shop-data/bad.json')).toBe(false);
    expect(await h.writer.apply(forged('good.json', '{"a": 1}').id)).toMatchObject({ ok: true });
    expect(h.read('shop-data/good.json')).toBe('{"a": 1}');
  });

  it('a card for a move between sets pins BOTH guides: editing a rule of the destination guide makes it stale', async () => {
    h.put('notes/GUIDE.md', guideWith({ name: 'notes' }, '# Notes\n\nPersonal notes.\n\n## File Ecosystem\n\n| File | Path | Loading Mechanism | Purpose | Audience |\n|---|---|---|---|---|\n| `idea.md` | notes/ | On demand | An idea | Me |\n\n## Change Methodology\n\n- Keep it short\n\n## Guardrails\n\n- Do NOT store secrets\n\n## Conflict Priority Order\n\nA > B\n'));
    h.put('notes/idea.md', '# An idea\n');
    const context = h.turn('move orders_analysis.md from shop-data to notes');
    const shopRules = await h.rules(context, 'shop-data', 'orders_analysis.md');
    context.guidesDelivered!['shop-data'].full = true;
    const args = { set: 'shop-data', file: 'orders_analysis.md', mode: 'move', toFile: 'analysis.md', toSet: 'notes', rulesSha256: shopRules, ...PROPOSE };
    expect(await h.writer.write(args, context, 'knowledge_propose')).toMatchObject({ code: 'guide_not_read' });
    h.queue({});
    const staged = await h.writer.write(args, context, 'knowledge_propose');
    expect(staged.status).toBe('staged');
    const plan = h.changes.get(String(staged.changeId))?.plan;
    expect(plan?.rulesGuides?.map((guard) => guard.path).sort()).toEqual(['notes/GUIDE.md', 'shop-data/GUIDE.md']);
    h.put('notes/GUIDE.md', h.read('notes/GUIDE.md').replace('- Do NOT store secrets', '- Do NOT store secrets or names'));
    expect(await h.writer.apply(String(staged.changeId))).toMatchObject({ ok: false, code: 'stale_base' });
    expect(h.changes.get(String(staged.changeId))?.status).toBe('stale');
    expect(h.exists('shop-data/orders_analysis.md')).toBe(true);
    expect(h.exists('notes/analysis.md')).toBe(false);
  });
});

describe('Retry check on a held change', () => {
  it('runs the check again: clean becomes a staged card, still unavailable stays held, a changed file becomes stale', async () => {
    h.setClient(null);
    const held = await h.write(h.turn('please add a note to shop-data orders.md'), ADD);
    const id = String(held.changeId);
    expect(h.changes.get(id)?.status).toBe('held');
    expect(await h.writer.recheck(id)).toMatchObject({ ok: false, code: 'held_check_unavailable', change: { status: 'held' } });
    // The model comes back (the harness client answers "nothing to fix" with an empty queue).
    const harness2 = await makeHarness();
    try {
      harness2.setClient(null);
      const heldAgain = await harness2.write(harness2.turn('please add a note to shop-data orders.md'), ADD);
      harness2.setClient({
        isAvailable: () => true, getContextBudgetTokens: () => 100_000, getMaxCompletionTokens: () => 16_384,
        chatCompletion: async () => ({ content: JSON.stringify({ items: [] }), toolCalls: null, finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
      } as never);
      expect(await harness2.writer.recheck(String(heldAgain.changeId))).toMatchObject({ ok: true, change: { status: 'staged', unresolved: [] } });
      // Still not applied by the recheck itself: the owner applies the clean card.
      expect(harness2.read('shop-data/orders.md')).not.toContain('placeholders');
      expect(await harness2.writer.apply(String(heldAgain.changeId))).toMatchObject({ ok: true });
      expect(harness2.read('shop-data/orders.md')).toContain('placeholders');
      // A held change whose file moved on becomes stale on recheck.
      harness2.setClient(null);
      const another = await harness2.write(harness2.turn('please add a note to shop-data orders.md'), { ...ADD, edits: [{ find: '- Use placeholders for dates.', replace: '- Use placeholders for dates and ids.' }] });
      harness2.put('shop-data/orders.md', `${harness2.read('shop-data/orders.md')}\n- edited elsewhere\n`);
      expect(await harness2.writer.recheck(String(another.changeId))).toMatchObject({ ok: false, code: 'stale_base' });
    } finally {
      harness2.close();
      fs.rmSync(harness2.base, { recursive: true, force: true });
    }
  });

  it('a change that is not held or staged cannot be rechecked, and the answer names the real status', async () => {
    expect(await h.writer.recheck('kc_000000000000')).toMatchObject({ ok: false, code: 'change_not_found' });
    h.queue({});
    const applied = await h.write(h.turn('please add a note to shop-data orders.md'), ADD);
    expect(await h.writer.recheck(String(applied.changeId))).toMatchObject({ ok: false, code: 'change_not_ready', message: expect.stringContaining('this one is applied') });
  });

  it('R5: a held NEW SET can be checked again; the card then applies and creates the set', async () => {
    const context = h.turn('create a research set about bees with a first note');
    h.queue(new Error('connection reset'));
    const reply = await h.createSet(context, { name: 'Bees', kind: 'research', description: 'Notes on the bee project', files: [{ name: 'sources.md', content: '# Sources\n\nA field guide.\n' }] });
    expect(reply).toMatchObject({ ok: false, code: 'held_check_unavailable', effect: 'staged' });
    const id = String(reply.changeId);
    expect(h.changes.get(id)).toMatchObject({ kind: 'create_set', status: 'held' });
    expect(await h.writer.apply(id)).toMatchObject({ ok: false, code: 'held_check_unavailable' });
    // Still unavailable: stays held. Then the model answers.
    h.queue(new Error('connection reset'));
    expect(await h.writer.recheck(id)).toMatchObject({ ok: false, code: 'held_check_unavailable', change: { status: 'held' } });
    expect(await h.writer.recheck(id)).toMatchObject({ ok: true, change: { status: 'staged', unresolved: [] } });
    expect(h.exists('research/bees/GUIDE.md')).toBe(false);
    expect(await h.writer.apply(id)).toMatchObject({ ok: true });
    expect(h.read('research/bees/sources.md')).toContain('A field guide');
    expect(h.exists('research/bees/GUIDE.md')).toBe(true);
  });

  it('R5: a held new set whose root rules were edited meanwhile becomes stale on Retry check', async () => {
    h.queue(new Error('connection reset'));
    const reply = await h.createSet(h.turn('create a research set about bees'), { name: 'Bees', kind: 'research', description: 'Bees', files: [{ name: 'sources.md', content: '# Sources\n' }] });
    h.put('GUIDE.md', h.read('GUIDE.md').replace('- Keep file names short, lowercase, with hyphens.', '- Keep file names short.'));
    expect(await h.writer.recheck(String(reply.changeId))).toMatchObject({ ok: false, code: 'stale_base' });
    expect(h.changes.get(String(reply.changeId))?.status).toBe('stale');
  });

  it('R5: Retry check of a held write splices the guide row and TOC summary from the model\'s summaryUpdate (O9)', async () => {
    h.queue(new Error('connection reset'));
    const held = await h.write(h.turn('please add a notes file to shop-data'), { set: 'shop-data', file: 'delivery.md', mode: 'create', content: '# Delivery\n\nCouriers and cut-off times.\n' });
    expect(held).toMatchObject({ code: 'held_check_unavailable' });
    const id = String(held.changeId);
    const guideAfter = (change: ReturnType<Harness['changes']['get']>) => change?.plan?.files.find((item) => item.path === 'shop-data/GUIDE.md')?.after ?? '';
    // Held: the server's refresh uses the first line of the file.
    expect(guideAfter(h.changes.get(id))).toContain('Delivery');
    expect(guideAfter(h.changes.get(id))).not.toContain('Courier cut-off rules');
    h.queue({ summaryUpdate: { purpose: 'Courier cut-off rules', bullets: ['Names each courier', 'Gives the daily cut-off time'] } });
    expect(await h.writer.recheck(id)).toMatchObject({ ok: true, change: { status: 'staged' } });
    const rechecked = h.changes.get(id);
    expect(guideAfter(rechecked)).toContain('Courier cut-off rules');
    expect(guideAfter(rechecked)).toContain('Gives the daily cut-off time');
    expect(rechecked?.diffText).toContain('Courier cut-off rules');
    expect(await h.writer.apply(id)).toMatchObject({ ok: true });
    expect(h.read('shop-data/GUIDE.md')).toContain('Gives the daily cut-off time');
    expect(h.read('shop-data/delivery.md')).toContain('Couriers and cut-off times.');
  });

  it('R5: a Retry check after the guide\'s rules were edited is stale, not a silent overwrite of the hand edit', async () => {
    h.queue(new Error('connection reset'));
    const held = await h.write(h.turn('please add a notes file to shop-data'), { set: 'shop-data', file: 'delivery.md', mode: 'create', content: '# Delivery\n\nCouriers.\n' });
    h.put('shop-data/GUIDE.md', h.read('shop-data/GUIDE.md').replace('## Guardrails', '## Guardrails\n\n- Do NOT mention couriers by name.'));
    h.queue({ summaryUpdate: { purpose: 'Courier rules', bullets: ['Names couriers'] } });
    expect(await h.writer.recheck(String(held.changeId))).toMatchObject({ ok: false, code: 'stale_base' });
    expect(h.read('shop-data/GUIDE.md')).toContain('Do NOT mention couriers by name.');
  });
});

describe('when the disk says no', () => {
  it('a failing guide write rolls the content file back from its pre-image and records nothing', async () => {
    const before = { orders: h.read('shop-data/orders.md'), guide: h.read('shop-data/GUIDE.md') };
    h.queue({ summaryUpdate: { bullets: ['Placeholders for dates'] } });
    const real = fsp.rename.bind(fsp);
    let calls = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      // Only the writes into the folder count (the history store renames files in its own folder too): the second one is the guide.
      if (String(to).startsWith(h.root)) {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      return real(from, to);
    });
    const reply = await h.write(h.turn('please add a note to shop-data orders.md'), ADD);
    expect(reply).toMatchObject({ ok: false, effect: 'none', code: 'internal_error', message: expect.stringContaining('nothing was changed') });
    vi.restoreAllMocks();
    expect(h.read('shop-data/orders.md')).toBe(before.orders);
    expect(h.read('shop-data/GUIDE.md')).toBe(before.guide);
    expect(h.history.list().some((entry) => entry.kind === 'write')).toBe(false);
    expect(h.changes.get(String(reply.changeId))).toMatchObject({ status: 'staged' });
    // The card can be applied once the disk allows it.
    expect(await h.writer.apply(String(reply.changeId))).toMatchObject({ ok: true });
    expect(h.read('shop-data/orders.md')).toContain('placeholders');
  });

  it('macOS refusing the folder (EPERM on Documents) is reported with the System Settings steps, never retried by code', async () => {
    const realRead = fsp.readFile.bind(fsp);
    const orders = h.abs('shop-data/orders.md');
    vi.spyOn(fsp, 'readFile').mockImplementation((async (file: unknown, ...rest: unknown[]) => {
      if (String(file) === orders) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      return (realRead as (...args: unknown[]) => unknown)(file, ...rest);
    }) as never);
    const reply = await h.write(h.turn('please add a note to shop-data orders.md'), ADD);
    expect(reply).toMatchObject({ ok: false, code: 'root_unavailable', effect: 'none', nextAction: expect.stringContaining('System Settings → Privacy & Security → Files and Folders') });
    vi.restoreAllMocks();
    expect(h.llmCalls).toHaveLength(0);
  });
});

describe('edits made outside BotBoy, and two writers', () => {
  it('an edit in Finder after BotBoy\'s last write is recorded as outside, the next candidate is built on the real file, and Undo then refuses to erase it', async () => {
    h.queue({});
    expect(await h.write(h.turn('please add a note to shop-data orders.md'), ADD)).toMatchObject({ status: 'applied' });
    h.put('shop-data/orders.md', `${h.read('shop-data/orders.md')}\n- Added by the owner in an editor.\n`);
    h.queue({});
    const reply = await h.write(h.turn('please add another note to shop-data orders.md'), { ...ADD, edits: [{ find: '- Use placeholders for dates.', replace: '- Use placeholders for dates.\n- And for ids.' }] });
    expect(reply).toMatchObject({ status: 'applied' });
    const kinds = h.history.list().map((entry) => `${entry.actor}:${entry.kind}`);
    expect(kinds).toContain('outside:outside');
    expect(h.read('shop-data/orders.md')).toContain('Added by the owner in an editor.');
    expect(h.read('shop-data/orders.md')).toContain('- And for ids.');
    // Undo reverses the last write only; the owner's edit stays.
    expect(await h.writer.undo()).toMatchObject({ ok: true });
    expect(h.read('shop-data/orders.md')).toContain('Added by the owner in an editor.');
    expect(h.read('shop-data/orders.md')).not.toContain('- And for ids.');
  });

  it('Undo refuses (changed_since) when the owner kept editing after the write', async () => {
    h.queue({});
    await h.write(h.turn('please add a note to shop-data orders.md'), ADD);
    fs.appendFileSync(h.abs('shop-data/orders.md'), '\n- the owner kept going\n');
    expect(await h.writer.undo()).toMatchObject({ ok: false, code: 'changed_since' });
  });

  it('two writes from the same base: exactly one wins, the other is stale with nothing corrupted', async () => {
    const one = h.turn('please update shop-data orders.md');
    const two = h.turn('please update shop-data orders.md');
    const a = { ...ADD, edits: [{ find: '- Always filter by channel.', replace: '- Always filter by channel (A).' }] };
    const b = { ...ADD, edits: [{ find: '- Always filter by channel.', replace: '- Always filter by channel (B).' }] };
    const [first, second] = await Promise.all([h.write(one, a), h.write(two, b)]);
    const statuses = [first, second].map((reply) => reply.code ?? reply.status).sort();
    expect(statuses).toEqual(['applied', 'stale_base']);
    const text = h.read('shop-data/orders.md');
    expect([text.includes('(A)'), text.includes('(B)')].filter(Boolean)).toHaveLength(1);
    expect(h.history.list().filter((entry) => entry.kind === 'write')).toHaveLength(1);
  });

  it('the folder never gets a .git entry and the journal lives outside it', async () => {
    h.queue({});
    await h.write(h.turn('please add a note to shop-data orders.md'), ADD);
    const names = fs.readdirSync(h.root).concat(fs.readdirSync(h.abs('shop-data')));
    expect(names.some((name) => name.startsWith('.git'))).toBe(false);
    expect(fs.existsSync(h.history.dir)).toBe(true);
    expect(h.history.dir.startsWith(h.root)).toBe(false);
  });
});

describe('R25: a Retry check never overwrites what the owner or the model did while it was waiting on the model', () => {
  /** A model whose FIRST call parks until released, then answers (or throws); later calls answer at once. */
  function parkFirstCall(first: 'clean' | Error, later: Record<string, unknown> = { items: [] }) {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const parked = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    const client = {
      isAvailable: () => true, getContextBudgetTokens: () => 100_000, getMaxCompletionTokens: () => 16_384,
      chatCompletion: async () => {
        calls += 1;
        if (calls === 1) { started(); await gate; if (first instanceof Error) throw first; }
        return { content: JSON.stringify(calls === 1 ? { items: [] } : later), toolCalls: null, finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
    } as unknown as LlmClient;
    return { client, release: () => release(), parked };
  }

  it('an Apply that lands while the check is on the model leaves the change applied; the check answers change_closed and saves nothing', async () => {
    const staged = await proposal();
    const id = String(staged.changeId);
    const model = parkFirstCall('clean');
    h.setClient(model.client);
    const rechecking = h.writer.recheck(id);
    await model.parked;
    expect(await h.writer.apply(id)).toMatchObject({ ok: true });
    model.release();
    expect(await rechecking).toMatchObject({ ok: false, code: 'change_closed', status: 409, message: expect.stringContaining('became applied') });
    expect(h.changes.get(id)).toMatchObject({ status: 'applied' });
    expect(h.read('shop-data/orders.md')).toContain('Use placeholders for dates.');
    expect(await h.writer.apply(id)).toMatchObject({ ok: false, code: 'change_closed' });
  });

  it('the same when the check then fails (held branch): an applied change is not turned into a held card', async () => {
    const staged = await proposal();
    const id = String(staged.changeId);
    const model = parkFirstCall(new Error('connection reset'));
    h.setClient(model.client);
    const rechecking = h.writer.recheck(id);
    await model.parked;
    expect(await h.writer.apply(id)).toMatchObject({ ok: true });
    model.release();
    expect(await rechecking).toMatchObject({ ok: false, code: 'change_closed' });
    expect(h.changes.get(id)?.status).toBe('applied');
  });

  it('a dismissal during the check wins too', async () => {
    const staged = await proposal();
    const id = String(staged.changeId);
    const model = parkFirstCall('clean');
    h.setClient(model.client);
    const rechecking = h.writer.recheck(id);
    await model.parked;
    h.writer.dismiss(id);
    model.release();
    expect(await rechecking).toMatchObject({ ok: false, code: 'change_closed', message: expect.stringContaining('became dismissed') });
    expect(h.changes.get(id)?.status).toBe('dismissed');
  });

  it('a revision that landed during the check wins: the stored candidate stays the revised one and the check says so', async () => {
    const staged = await proposal();
    const id = String(staged.changeId);
    const model = parkFirstCall('clean');
    h.setClient(model.client);
    const rechecking = h.writer.recheck(id);
    await model.parked;
    // The owner reopened the card and the model revised it meanwhile (another candidate, round 2).
    const reopened = h.turn('Please fix this change so it follows the guide.', { openChangeIds: [id] });
    const revised = await h.write(reopened, { ...ADD, edits: [{ find: '- Always filter by channel.', replace: '- Always filter by channel.\n- Use a placeholder for every period.' }], changeId: id });
    expect(revised).toMatchObject({ status: 'staged' });
    const revisedSha = h.changes.get(id)?.candidateSha256;
    model.release();
    expect(await rechecking).toMatchObject({ ok: false, code: 'change_not_ready', message: expect.stringContaining('revised while it was being checked') });
    expect(h.changes.get(id)).toMatchObject({ status: 'staged', round: 2, candidateSha256: revisedSha });
  });

  it('the result is written under the per-root lock: while an Apply holds it the check waits, then sees the applied change', async () => {
    const staged = await proposal();
    const id = String(staged.changeId);
    const model = parkFirstCall('clean');
    h.setClient(model.client);
    const rechecking = h.writer.recheck(id);
    await model.parked;
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((resolve) => { releaseLock = resolve; });
    const holder = h.library.withLock(async () => { await lockGate; h.changes.update(id, { status: 'applied' }); });
    model.release();
    const early = await Promise.race([rechecking.then(() => 'settled'), new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 100))]);
    expect(early).toBe('waiting');
    releaseLock();
    await holder;
    expect(await rechecking).toMatchObject({ ok: false, code: 'change_closed' });
    expect(h.changes.get(id)?.status).toBe('applied');
  });

  it('a revision with the SAME candidate that put the change back in the loop is not overwritten either', async () => {
    const staged = await proposal();
    const id = String(staged.changeId);
    const model = parkFirstCall('clean', { items: [dateBreach('Use placeholders for dates.')] });
    h.setClient(model.client);
    const rechecking = h.writer.recheck(id);
    await model.parked;
    const reopened = h.turn('Please fix this change so it follows the guide.', { openChangeIds: [id] });
    const revised = await h.write(reopened, { ...ADD, changeId: id });
    expect(revised).toMatchObject({ status: 'needs_changes' });
    expect(h.changes.get(id)).toMatchObject({ status: 'revising' });
    model.release();
    expect(await rechecking).toMatchObject({ ok: false, code: 'change_not_ready' });
    expect(h.changes.get(id)?.status).toBe('revising');
  });

  it('a change that no longer exists when the check comes back is change_not_found, not a crash', async () => {
    const staged = await proposal();
    const id = String(staged.changeId);
    const model = parkFirstCall('clean');
    h.setClient(model.client);
    const rechecking = h.writer.recheck(id);
    await model.parked;
    h.storage.getDb().prepare('DELETE FROM knowledge_changes WHERE id = ?').run(id);
    model.release();
    expect(await rechecking).toMatchObject({ ok: false, code: 'change_not_found', status: 404 });
  });

  it('a new set: an Apply during its Retry check leaves it applied and created', async () => {
    const created = await h.createSet(h.turn('create a research set about bees'), { name: 'Bees', kind: 'research', description: 'Notes on bees', files: [{ name: 'sources.md', content: '# Sources\n\nA field guide.\n' }] });
    const id = String(created.changeId);
    const model = parkFirstCall('clean');
    h.setClient(model.client);
    const rechecking = h.writer.recheck(id);
    await model.parked;
    expect(await h.writer.apply(id)).toMatchObject({ ok: true });
    model.release();
    expect(await rechecking).toMatchObject({ ok: false, code: 'change_closed' });
    expect(h.changes.get(id)?.status).toBe('applied');
    expect(h.exists('research/bees/GUIDE.md')).toBe(true);
  });

  it('with nothing in the way a Retry check still saves its result (a held change becomes a card)', async () => {
    h.queue(new Error('connection reset'));
    const held = await h.write(h.turn('please add a note to shop-data orders.md'), ADD);
    expect(held).toMatchObject({ code: 'held_check_unavailable' });
    h.useFakeModel();
    const result = await h.writer.recheck(String(held.changeId));
    expect(result).toMatchObject({ ok: true, change: { status: 'staged', unresolved: [] } });
    expect(h.changes.get(String(held.changeId))?.status).toBe('staged');
  });
});
