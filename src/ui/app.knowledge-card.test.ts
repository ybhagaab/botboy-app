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
    topLevel('fillKnowledgeCard'), topLevel('paintKnowledgeCard'),
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
const labels = () => [...card().querySelectorAll('button')].map((button) => button.textContent);
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
    expect(labels()).toEqual(['Apply', 'Dismiss']);
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

describe('the five states and their buttons', () => {
  it.each([
    ['clean', change(), ['Apply', 'Dismiss']],
    ['a guide breach is open', change({ unresolved: [BREACH], needsAnyway: true }), ['Apply anyway', 'Ask BotBoy to fix', 'Dismiss']],
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

  it('a card for text from an untrusted source says where it came from, shows the WHOLE diff, and its button reads Review and apply', async () => {
    const long = ['--- a/orders.md', '+++ b/orders.md', ...Array.from({ length: 400 }, (_, index) => `+ line ${index}`)].join('\n');
    holder.api = async () => change({ sources: ['email', 'web page'], needsConfirm: true, diff: long });
    await mount();
    expect(card().textContent).toContain('Derived from email, web page');
    expect(card().querySelectorAll('.knowledge-diff-line')).toHaveLength(402);
    expect(card().querySelector('[data-knowledge-action="diff-more"]')).toBeNull();
    expect(labels()).toEqual(['Review and apply', 'Dismiss']);
  });

  it('shows the first 200 diff lines of a clean card, with a button for the rest', async () => {
    const long = ['--- a/orders.md', '+++ b/orders.md', ...Array.from({ length: 400 }, (_, index) => `+ line ${index}`)].join('\n');
    holder.api = async () => change({ diff: long });
    await mount();
    expect(card().querySelectorAll('.knowledge-diff-line')).toHaveLength(200);
    await click('diff-more');
    expect(card().querySelectorAll('.knowledge-diff-line')).toHaveLength(402);
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
    expect(card().textContent).toContain('<script>alert(2)</script>');
  });
});

describe('the buttons', () => {
  it('Apply sends two booleans and NO text, then paints the applied card', async () => {
    holder.api = async (p: string, o?: ApiCall['options']) => (o?.method === 'POST' ? { ok: true, change: change({ status: 'applied' }) } : change());
    await mount();
    await click('apply');
    const post = calls.find((entry) => entry.options?.method === 'POST')!;
    expect(post.path).toBe(`/knowledge/changes/${ID}/apply`);
    expect(post.options?.body).toEqual({ anyway: false, confirmFlagged: false });
    expect(labels()).toEqual(['Undo']);
    expect(card().textContent).toContain('Applied');
  });

  it('Apply anyway sets anyway; Review and apply on an untrusted card sets confirmFlagged, and neither carries content', async () => {
    holder.api = async (p: string, o?: ApiCall['options']) => (o?.method === 'POST' ? { ok: true, change: change({ status: 'applied' }) } : change({ unresolved: [BREACH], needsAnyway: true, sources: ['email'], needsConfirm: true }));
    await mount();
    await click('apply-anyway');
    expect(calls.find((entry) => entry.options?.method === 'POST')!.options?.body).toEqual({ anyway: true, confirmFlagged: true });
    expect(JSON.stringify(calls.map((entry) => entry.options?.body))).not.toMatch(/content|edits/);
  });

  it('a refusal from the server repaints the card with the reason and the next step, and the buttons work again', async () => {
    holder.api = async (p: string, o?: ApiCall['options']) => (o?.method === 'POST'
      ? { error: 'The file or the guide changed after this was prepared.', code: 'stale_base', nextAction: 'Use Re-draft.', change: change({ status: 'stale' }) } : change());
    await mount();
    await click('apply');
    expect(labels()).toEqual(['Re-draft', 'Dismiss']);
    expect(card().textContent).toContain('The file or the guide changed after this was prepared. Use Re-draft.');
    expect([...card().querySelectorAll('button')].every((button) => !button.disabled)).toBe(true);
  });

  it('a request that fails says so, keeps the card, and re-enables the buttons', async () => {
    holder.api = async (p: string, o?: ApiCall['options']) => { if (o?.method === 'POST') throw new Error('network down'); return change(); };
    await mount();
    await click('apply');
    expect(card().textContent).toContain('Could not do that: network down');
    expect(labels()).toEqual(['Apply', 'Dismiss']);
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
    expect(labels()).toEqual(['Apply', 'Dismiss']);
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
