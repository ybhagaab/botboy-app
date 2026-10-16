// @vitest-environment jsdom
//
// The Knowledge change card in chat (app.js + knowledge-ui.js, docs/maps/knowledge-library.md K18, K19). The helpers and the
// delegated click listener are evaluated straight from the shipped source against a stub api(), like
// app.gmail-draft-card.test.ts does; the renderer is the real knowledge-ui.js.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const app = readFileSync(path.join(process.cwd(), 'src/ui/app.js'), 'utf8');
const uiSource = readFileSync(path.join(process.cwd(), 'src/ui/knowledge-ui.js'), 'utf8');
function topLevel(name: string): string {
  const start = app.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  return app.slice(start, app.indexOf('\n}\n', start) + 2);
}
function constLine(name: string): string {
  const match = app.match(new RegExp(`\\nconst ${name} = .*\\n`));
  expect(match, `missing const ${name}`).not.toBeNull();
  return match![0];
}
/** The one line that subscribes the chat cards to the dashboard's "the Knowledge changes moved" event. */
function knowledgeChangedListener(): string {
  const line = "window.addEventListener('botboy:knowledge-changed', refreshKnowledgeCards);";
  expect(app, 'missing the knowledge-changed subscription').toContain(`\n${line}\n`);
  return line;
}
function knowledgeClickListener(): string {
  const start = app.indexOf("document.addEventListener('click', async (event) => {\n  const button = event.target.closest('.knowledge-chat-card [data-knowledge-action]');");
  expect(start, 'missing the knowledge card click listener').toBeGreaterThanOrEqual(0);
  return app.slice(start, app.indexOf('\n});\n', start) + 4);
}
type ApiCall = { path: string; options?: { method?: string; body?: unknown } };
const holder: { api: (path: string, options?: ApiCall['options']) => Promise<any> } = { api: async () => ({}) };
let hydrateChatCards: (root: Element) => void;
let calls: ApiCall[];
const submit = vi.fn(async () => undefined);

const ID = 'kc_0123456789ab';
const change = (over: Record<string, unknown> = {}) => ({
  id: ID, set: 'shop-data', kind: 'write', mode: 'edit', file: 'orders.md', status: 'staged', statusReason: null, origin: 'botboy_proposal', sources: [], why: 'verified in a real query',
  trigger: 'verified_fact', round: 1, attempt: 1, suspicious: false, unresolved: [], notes: [], check: {}, overrode: [], files: [{ path: 'shop-data/orders.md', effect: 'changed' }],
  diff: '--- a/orders.md\n+++ b/orders.md\n@@\n- Always filter by channel.\n+ Always filter by channel.\n+ Use placeholders for dates.', historyId: null,
  needsAnyway: false, needsConfirm: false, actions: ['apply', 'dismiss', 'recheck'], ...over,
});
const BREACH = { tier: 'must_fix', rule: 'Do NOT add hardcoded dates', where: { file: 'orders.md', line: 8 }, problem: 'The new line names a date.', evidence: 'x', fix: 'Say "the campaign".', source: 'model' };

beforeAll(() => {
  // eslint-disable-next-line no-new-func
  new Function(uiSource)();
  const source = [
    constLine('LESSON_MARKER_RE'), constLine('GMAIL_DRAFT_MARKER_RE'), constLine('MCP_SERVER_MARKER_RE'), constLine('KNOWLEDGE_MARKER_RE'),
    topLevel('hydrateChatCards'), topLevel('fillLessonCard'), topLevel('lessonEsc'), topLevel('paintLessonCard'),
    topLevel('fillGmailDraftCard'), topLevel('gmailDraftWhen'), topLevel('gmailFileSize'), topLevel('paintGmailDraftCard'),
    topLevel('fillMcpServerCard'), topLevel('mcpCardTransport'), topLevel('paintMcpServerCard'),
    topLevel('fillKnowledgeCard'), topLevel('paintKnowledgeCard'), topLevel('refreshKnowledgeCards'), knowledgeChangedListener(),
    knowledgeClickListener(),
    'return { hydrateChatCards };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  ({ hydrateChatCards } = new Function('api', source)((p: string, o?: ApiCall['options']) => {
    calls.push({ path: p, options: o });
    return holder.api(p, o);
  }));
  (window as unknown as { submitChat: () => Promise<void> }).submitChat = submit;
});
beforeEach(() => {
  calls = [];
  submit.mockClear();
  document.body.innerHTML = '<textarea id="chatInput"></textarea><div id="chat-messages"></div>';
  holder.api = async (p: string) => (p === `/knowledge/changes/${ID}` ? change() : {});
});
async function settle() { for (let index = 0; index < 6; index++) await new Promise((resolve) => setTimeout(resolve, 0)); }
async function mount(content = `I prepared a change. [[knowledge:${ID}]]`, role = 'assistant') {
  const bubble = document.createElement('div');
  bubble.className = `chat-msg ${role}`;
  bubble.innerHTML = content;
  document.getElementById('chat-messages')!.appendChild(bubble);
  hydrateChatCards(bubble);
  await settle();
  return bubble;
}
const card = () => document.querySelector('.knowledge-chat-card') as HTMLElement;
// Everything in the card's action row: the "Review in Knowledge" link counts beside the buttons.
const labels = () => [...card().querySelectorAll('.knowledge-card-actions > a, .knowledge-card-actions > button')].map((element) => element.textContent);
const click = async (action: string) => {
  (card().querySelector(`[data-knowledge-action="${action}"]`) as HTMLElement).click();
  await settle();
};

describe('the marker becomes a card', () => {
  it('expands [[knowledge:kc_…]] in an assistant or a user bubble, fetches the change once and paints it', async () => {
    await mount();
    expect(calls).toEqual([{ path: `/knowledge/changes/${ID}`, options: undefined }]);
    expect(card().textContent).toContain('BotBoy proposes');
    expect(card().textContent).toContain('Edit orders.md in shop-data');
    expect(card().textContent).toContain('verified in a real query');
    expect(document.body.textContent).not.toContain('[[knowledge:');
    expect(labels()).toEqual(['Review in Knowledge', 'Dismiss']);
    document.getElementById('chat-messages')!.innerHTML = '';
    await mount(`Please fix it. [[knowledge:${ID}]]`, 'user');
    expect(card()).not.toBeNull();
  });

  it('leaves a marker of another shape alone and says so when the change is gone', async () => {
    await mount('see [[knowledge:kc_nothex]] and [[knowledge:kc_0123456789a]]');
    expect(document.querySelector('.knowledge-chat-card')).toBeNull();
    holder.api = async () => ({ error: 'gone' });
    document.getElementById('chat-messages')!.innerHTML = '';
    await mount();
    expect(card().textContent).toContain('This change is unavailable.');
  });

  it('hydrates every kind of card in one bubble with one write', async () => {
    holder.api = async (p: string) => (p === `/knowledge/changes/${ID}` ? change() : p.startsWith('/lessons/') ? { lesson: { id: 'lesson_ab12cd34ef56', scope: 'general', rule: 'r', evidence: 'e', status: 'proposed', recurrenceCount: 1 } } : {});
    await mount(`one [[lesson:lesson_ab12cd34ef56]] two [[knowledge:${ID}]]`);
    expect(document.querySelectorAll('.lesson-card')).toHaveLength(1);
    expect(card().textContent).toContain('Edit orders.md in shop-data');
  });
});

describe('the compact chat card (owner decision 2026-10-16: no preview in a bubble, a button to Settings → Knowledge instead)', () => {
  it('shows a summary and a link to the Knowledge page, never the diff, and no way to apply from chat', async () => {
    const long = ['--- a/orders.md', '+++ b/orders.md', '@@ -0,0 +1,400 @@', ...Array.from({ length: 400 }, (_, index) => `+ line ${index}`)].join('\n');
    holder.api = async () => change({ diff: long, files: Array.from({ length: 9 }, (_, index) => ({ path: `set/file-${index}.md`, effect: 'created' })) });
    await mount();
    expect(card().querySelector('.knowledge-diff')).toBeNull();
    expect(card().querySelectorAll('.knowledge-diff-line')).toHaveLength(0);
    expect(card().querySelector('[data-knowledge-action="diff-expand"]')).toBeNull();
    expect(card().querySelector('.knowledge-card-summary')!.textContent).toBe('9 files · 400 lines added');
    const link = card().querySelector('a[data-knowledge-action="open-page"]') as HTMLAnchorElement;
    expect(link.textContent).toBe('Review in Knowledge');
    expect(link.getAttribute('href')).toBe('#/settings/knowledge');
    expect(link.getAttribute('data-change-id')).toBe(ID);
    expect(card().textContent).toContain('Read the whole change in Settings → Knowledge');
    expect(card().querySelector('[data-knowledge-action="apply"], [data-knowledge-action="apply-anyway"]')).toBeNull();
    expect(card().textContent).not.toContain('line 399');
  });

  it('counts removed lines too, and says so when a change has no text diff', async () => {
    await mount();
    expect(card().querySelector('.knowledge-card-summary')!.textContent).toBe('1 file · 2 lines added, 1 removed');
    document.getElementById('chat-messages')!.innerHTML = '';
    holder.api = async () => change({ diff: '' });
    await mount();
    expect(card().querySelector('.knowledge-card-summary')).toBeNull();
  });

  it('a click on the link is left to the browser: chat posts nothing and does not stop the navigation', async () => {
    await mount();
    const link = card().querySelector('a[data-knowledge-action="open-page"]') as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    await settle();
    expect(event.defaultPrevented).toBe(false);
    expect(calls.filter((entry) => entry.options?.method === 'POST')).toEqual([]);
  });

  it('chat has no apply code path at all: a forged apply button posts nothing', async () => {
    await mount();
    const forged = document.createElement('button');
    forged.setAttribute('data-knowledge-action', 'apply');
    forged.setAttribute('data-change-id', ID);
    card().appendChild(forged);
    forged.click();
    await settle();
    expect(calls.filter((entry) => entry.options?.method === 'POST')).toEqual([]);
  });
});
describe('the five states and their buttons', () => {
  it.each([
    ['clean', change(), ['Review in Knowledge', 'Dismiss']],
    ['a guide breach is open', change({ unresolved: [BREACH], needsAnyway: true }), ['Review in Knowledge', 'Ask BotBoy to fix', 'Dismiss']],
    ['the check could not run', change({ status: 'held', check: { nextAction: 'Open Settings → AI model.' } }), ['Retry check', 'Dismiss']],
    ['the file moved on', change({ status: 'stale' }), ['Re-draft', 'Dismiss']],
    ['applied', change({ status: 'applied', historyId: 'h_000000000001' }), ['Undo']],
  ])('%s', async (_name, payload, expected) => {
    holder.api = async () => payload;
    await mount();
    expect(labels()).toEqual(expected);
  });

  it('names an open breach with its rule, problem and fix, and a held card with its next action', async () => {
    holder.api = async () => change({ unresolved: [BREACH], needsAnyway: true });
    await mount();
    expect(card().textContent).toContain('Do NOT add hardcoded dates');
    expect(card().textContent).toContain('The new line names a date.');
    expect(card().textContent).toContain('Say "the campaign".');
    document.getElementById('chat-messages')!.innerHTML = '';
    holder.api = async () => change({ status: 'held', check: { nextAction: 'Open Settings → AI model.' } });
    await mount();
    expect(card().textContent).toContain('could not run');
    expect(card().textContent).toContain('Open Settings → AI model.');
  });

  it('a card for text from an untrusted source says where it came from and still shows no diff in chat, only the way to read it', async () => {
    const long = ['--- a/orders.md', '+++ b/orders.md', ...Array.from({ length: 400 }, (_, index) => `+ line ${index}`)].join('\n');
    holder.api = async () => change({ sources: ['email', 'web page'], needsConfirm: true, diff: long });
    await mount();
    expect(card().textContent).toContain('Derived from email, web page');
    expect(card().textContent).toContain('read the whole change before you apply it');
    expect(card().querySelectorAll('.knowledge-diff-line')).toHaveLength(0);
    expect(labels()).toEqual(['Review in Knowledge', 'Dismiss']);
  });

  it('escapes everything a model or a file could have written into a card', async () => {
    holder.api = async () => change({
      set: '<img src=x onerror=alert(1)>', file: '"><script>alert(1)</script>', why: '<b>bold</b>', diff: '+<script>alert(2)</script>',
      unresolved: [{ ...BREACH, rule: '<i>rule</i>', problem: '<script>p</script>', fix: '<u>f</u>' }], needsAnyway: true, sources: ['<s>x</s>'],
    });
    await mount();
    expect(card().querySelector('script')).toBeNull();
    expect(card().querySelector('img')).toBeNull();
    expect(card().querySelector('b')).toBeNull();
    expect(card().querySelector('i')).toBeNull();
    expect(card().querySelector('u')).toBeNull();
    expect(card().querySelector('s')).toBeNull();
    expect(card().textContent).toContain('<img src=x onerror=alert(1)>');
    expect(card().textContent).toContain('<script>p</script>');
    // The diff text itself is not in the chat card at all.
    expect(card().textContent).not.toContain('alert(2)');
  });
});

describe('the buttons', () => {
  it('a refusal from the server repaints the card with the reason and the next step, and the buttons work again', async () => {
    holder.api = async (p: string, o?: ApiCall['options']) => (o?.method === 'POST'
      ? { error: 'The file or the guide changed after this was prepared.', code: 'stale_base', nextAction: 'Use Re-draft.', change: change({ status: 'stale' }) } : change());
    await mount();
    await click('dismiss');
    expect(labels()).toEqual(['Re-draft', 'Dismiss']);
    expect(card().textContent).toContain('The file or the guide changed after this was prepared. Use Re-draft.');
    expect([...card().querySelectorAll('button')].every((button) => !button.disabled)).toBe(true);
  });

  it('a request that fails says so, keeps the card, and re-enables the buttons', async () => {
    holder.api = async (p: string, o?: ApiCall['options']) => { if (o?.method === 'POST') throw new Error('network down'); return change(); };
    await mount();
    await click('dismiss');
    expect(card().textContent).toContain('Could not do that: network down');
    expect(labels()).toEqual(['Review in Knowledge', 'Dismiss']);
    expect([...card().querySelectorAll('button')].every((button) => !button.disabled)).toBe(true);
  });

  it('Dismiss, Retry check and Undo post to their own routes; Undo paints the undone state', async () => {
    holder.api = async (p: string, o?: ApiCall['options']) => (o?.method === 'POST' ? (p.endsWith('/undo') ? { ok: true, entry: {}, undone: {} } : { ok: true, change: change({ status: p.endsWith('/dismiss') ? 'dismissed' : 'staged' }) }) : change({ status: 'applied' }));
    await mount();
    await click('undo');
    expect(calls.at(-1)!.path).toBe(`/knowledge/changes/${ID}/undo`);
    expect(card().textContent).toContain('Undone. The file is back as it was before this change.');
    expect(labels()).toEqual([]);
    document.getElementById('chat-messages')!.innerHTML = '';
    holder.api = async (p: string, o?: ApiCall['options']) => (o?.method === 'POST' ? { ok: true, change: change({ status: p.endsWith('/dismiss') ? 'dismissed' : 'staged' }) } : change({ status: 'held' }));
    await mount();
    await click('recheck');
    expect(calls.at(-1)!.path).toBe(`/knowledge/changes/${ID}/recheck`);
    expect(labels()).toEqual(['Review in Knowledge', 'Dismiss']);
    await click('dismiss');
    expect(calls.at(-1)!.path).toBe(`/knowledge/changes/${ID}/dismiss`);
    expect(card().textContent).toContain('Dismissed. Nothing was written.');
  });

  it('Ask BotBoy to fix and Re-draft send an ordinary owner message that carries the card marker', async () => {
    holder.api = async () => change({ unresolved: [BREACH], needsAnyway: true });
    await mount();
    await click('ask-fix');
    expect((document.getElementById('chatInput') as HTMLTextAreaElement).value).toBe(`Please fix this change so it follows the guide. [[knowledge:${ID}]]`);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(calls.filter((entry) => entry.options?.method === 'POST')).toEqual([]);
    document.getElementById('chat-messages')!.innerHTML = '';
    holder.api = async () => change({ status: 'stale' });
    await mount();
    await click('redraft');
    expect((document.getElementById('chatInput') as HTMLTextAreaElement).value).toBe(`Please prepare this change again from the current file and rules. [[knowledge:${ID}]]`);
    expect(submit).toHaveBeenCalledTimes(2);
  });
});

// Owner report 2026-10-16: "when I saved a proposed knowledge the CTA in chat still said Review in Knowledge; after I refreshed it
// went away." The card read its change once, when the bubble was drawn. dashboard.js now announces "the Knowledge changes moved"
// (an event, from the version poll it already runs and right after the owner's own click), and each card reads itself again.
describe('the card follows its change (K20)', () => {
  const announce = () => window.dispatchEvent(new CustomEvent('botboy:knowledge-changed'));
  const OTHER = 'kc_abcdef012345';

  it('a decision made on the Settings page or in another tab repaints the card: the Review link is gone and Undo is offered', async () => {
    await mount();
    expect(labels()).toEqual(['Review in Knowledge', 'Dismiss']);
    calls.length = 0;
    holder.api = async () => change({ status: 'applied', historyId: 'h_000000000001' });
    announce();
    await settle();
    expect(calls).toEqual([{ path: `/knowledge/changes/${ID}`, options: undefined }]);
    expect(labels()).toEqual(['Undo']);
    expect(card().textContent).not.toContain('Review in Knowledge');
  });

  it('when nothing moved on this change the card is not redrawn at all (the same nodes stay: no flicker, no lost focus)', async () => {
    await mount();
    const link = card().querySelector('a[data-knowledge-action="open-page"]');
    const dismiss = card().querySelector('button[data-knowledge-action="dismiss"]');
    calls.length = 0;
    announce();
    await settle();
    expect(calls).toHaveLength(1); // it did look
    expect(card().querySelector('a[data-knowledge-action="open-page"]')).toBe(link);
    expect(card().querySelector('button[data-knowledge-action="dismiss"]')).toBe(dismiss);
  });

  it('a refresh that fails keeps the card the owner is reading, whether the network is down or the change is gone', async () => {
    await mount();
    for (const broken of [async () => { throw new Error('network down'); }, async () => ({ error: 'That change is unknown or has expired.' })]) {
      holder.api = broken;
      announce();
      await settle();
      expect(card().textContent).toContain('Edit orders.md in shop-data');
      expect(card().textContent).not.toContain('unavailable');
      expect(labels()).toEqual(['Review in Knowledge', 'Dismiss']);
    }
  });

  it('a card that can not change any more is not asked about again: dismissed, expired, and undone from the card', async () => {
    for (const status of ['dismissed', 'expired']) {
      document.getElementById('chat-messages')!.innerHTML = '';
      holder.api = async () => change({ status, actions: [] });
      await mount();
      calls.length = 0;
      announce();
      await settle();
      expect(calls, status).toEqual([]);
    }
    document.getElementById('chat-messages')!.innerHTML = '';
    holder.api = async (p: string, o?: ApiCall['options']) => (o?.method === 'POST' ? { ok: true, entry: {}, undone: {} } : change({ status: 'applied', historyId: 'h_000000000001' }));
    await mount();
    await click('undo');
    calls.length = 0;
    announce();
    await settle();
    expect(calls).toEqual([]);
    expect(card().textContent).toContain('Undone. The file is back as it was before this change.');
  });

  it('a click in flight owns the card: no refresh is sent, and a refresh that began earlier cannot repaint over the click', async () => {
    await mount();
    let finishClick!: (value: unknown) => void;
    holder.api = (_p: string, o?: ApiCall['options']) => (o?.method === 'POST' ? new Promise((resolve) => { finishClick = resolve; }) : Promise.resolve(change()));
    (card().querySelector('[data-knowledge-action="dismiss"]') as HTMLElement).click();
    await settle();
    expect([...card().querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
    calls.length = 0;
    announce();
    await settle();
    expect(calls).toEqual([]); // not even asked while the click is in flight
    finishClick({ ok: true, change: change({ status: 'dismissed', actions: [] }) });
    await settle();
    expect(card().textContent).toContain('Dismissed. Nothing was written.');

    // The other order: the refresh starts first and its answer is slow; the owner clicks meanwhile.
    document.getElementById('chat-messages')!.innerHTML = '';
    holder.api = async () => change();
    await mount();
    let lateAnswer!: (value: unknown) => void;
    let secondClick!: (value: unknown) => void;
    holder.api = (_p: string, o?: ApiCall['options']) => (o?.method === 'POST'
      ? new Promise((resolve) => { secondClick = resolve; })
      : new Promise((resolve) => { lateAnswer = resolve; }));
    announce(); // the refresh GET is now waiting for its answer
    (card().querySelector('[data-knowledge-action="dismiss"]') as HTMLElement).click(); // the click disables the buttons
    await settle();
    lateAnswer(change({ why: 'a reason that arrived late' }));
    await settle();
    expect(card().textContent).not.toContain('a reason that arrived late');
    expect([...card().querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
    secondClick({ ok: true, change: change({ status: 'dismissed', actions: [] }) });
    await settle();
    expect(card().textContent).toContain('Dismissed. Nothing was written.');
  });

  it('every change card in the chat reads itself again, each one for its own change', async () => {
    holder.api = async (p: string) => change({ id: p.split('/').pop() });
    await mount();
    await mount(`another [[knowledge:${OTHER}]]`);
    expect(document.querySelectorAll('.knowledge-chat-card')).toHaveLength(2);
    calls.length = 0;
    announce();
    await settle();
    expect(calls.map((entry) => entry.path).sort()).toEqual([`/knowledge/changes/${ID}`, `/knowledge/changes/${OTHER}`].sort());
  });
});
