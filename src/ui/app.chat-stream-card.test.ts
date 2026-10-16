// @vitest-environment jsdom
//
// A finished streamed turn keeps its approval card (app.js › createChatStreamBubble, docs/maps/knowledge-library.md K20).
//
// Live bug 2026-10-16: the model wrote [[knowledge:kc_…]] itself, so the server had nothing to append and `done` followed
// the last token at once. The token had queued a render for the next animation frame; `done` rendered the bubble and
// expanded the card; then the queued frame re-rendered the bubble from its raw segments and the card turned back into the
// marker text. onDone had already put the message into state.chatMessages, so the 5 s poll saw an unchanged last message
// and never repainted: the bubble stayed raw for good. The other suites stub requestAnimationFrame as synchronous, which
// is why none of them could see it. Here the frame is a queue that the test flushes when a browser would.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

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

type ApiCall = { path: string; options?: { method?: string; body?: unknown } };
type Bubble = { msgEl: HTMLElement; handle: (event: Record<string, unknown>) => void; finishIfLive: (text: string) => void; fail: (text: string) => void; isLive: () => boolean };
let createChatStreamBubble: (chatEl: Element, hooks?: Record<string, unknown>) => Bubble;
let calls: ApiCall[];
let frames: Array<() => void>;

const ID = 'kc_2567959bf2c1';
// The same change shape app.knowledge-card.test.ts paints; only its id is the one from the live bubble.
const change = {
  id: ID, set: 'shop-data', kind: 'write', mode: 'edit', file: 'orders.md', status: 'staged', statusReason: null, origin: 'botboy_proposal', sources: [], why: 'verified in a real query',
  trigger: 'verified_fact', round: 1, attempt: 1, suspicious: false, unresolved: [], notes: [], check: {}, overrode: [], files: [{ path: 'shop-data/orders.md', effect: 'changed' }],
  diff: '--- a/orders.md\n+++ b/orders.md\n@@\n- Always filter by channel.\n+ Always filter by channel.\n+ Use placeholders for dates.', historyId: null,
  needsAnyway: false, needsConfirm: false, actions: ['apply', 'dismiss', 'recheck'],
};
const REPLY = `I prepared the set and staged it for your approval.\n\n**Please approve the Knowledge creation card in this chat or Settings → Knowledge.**\n\n[[knowledge:${ID}]]`;

beforeAll(() => {
  // eslint-disable-next-line no-new-func
  new Function(uiSource)();
  const source = [
    constLine('LESSON_MARKER_RE'), constLine('GMAIL_DRAFT_MARKER_RE'), constLine('MCP_SERVER_MARKER_RE'), constLine('KNOWLEDGE_MARKER_RE'), constLine('THEME_MARKER_RE'),
    topLevel('escHtml'), topLevel('createChatStreamBubble'),
    topLevel('hydrateChatCards'), topLevel('fillLessonCard'), topLevel('lessonEsc'), topLevel('paintLessonCard'),
    topLevel('fillGmailDraftCard'), topLevel('gmailDraftWhen'), topLevel('gmailFileSize'), topLevel('paintGmailDraftCard'),
    topLevel('fillMcpServerCard'), topLevel('mcpCardTransport'), topLevel('paintMcpServerCard'),
    topLevel('fillKnowledgeCard'), topLevel('paintKnowledgeCard'),
    topLevel('fillThemeCard'), topLevel('paintThemeCard'),
    'return { createChatStreamBubble };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  ({ createChatStreamBubble } = new Function('api', 'formatMarkdownContent', 'requestAnimationFrame', source)(
    async (p: string, o?: ApiCall['options']) => {
      calls.push({ path: p, options: o });
      return p === `/knowledge/changes/${ID}` ? change : {};
    },
    // The real renderer keeps the marker as plain paragraph text; paragraphs are all this suite needs of it.
    (raw: string) => String(raw).split(/\n{2,}/).map((part) => `<p>${part}</p>`).join(''),
    (callback: () => void) => { frames.push(callback); return frames.length; },
  ));
});

beforeEach(() => {
  calls = [];
  frames = [];
  document.body.innerHTML = '<div id="chat-messages"></div>';
});

const chatEl = () => document.getElementById('chat-messages')!;
const settle = async () => { for (let index = 0; index < 6; index++) await new Promise((resolve) => setTimeout(resolve, 0)); };
/** The browser's next animation frame: runs what was queued, in order. */
const nextFrame = () => { const due = frames.splice(0); for (const callback of due) callback(); };
const cards = () => chatEl().querySelectorAll('.knowledge-chat-card');
const done = (content: string) => ({ type: 'done', message: { id: 'asst-1', role: 'assistant', content } });

describe('the card survives the end of a streamed turn', () => {
  it('done arriving in the frame of the last token: the queued render does not put the raw marker back', async () => {
    const bubble = createChatStreamBubble(chatEl());
    bubble.handle({ type: 'token', text: REPLY });
    expect(frames).toHaveLength(1); // the token queued a render for the next frame
    bubble.handle(done(REPLY)); // ... and `done` follows before that frame
    await settle();
    expect(cards()).toHaveLength(1);
    nextFrame(); // the frame the token queued
    await settle();
    expect(cards()).toHaveLength(1);
    expect(chatEl().textContent).not.toContain('[[knowledge:');
    expect(chatEl().textContent).toContain('Edit orders.md in shop-data');
    // The chat card is compact: a link to Settings → Knowledge and Dismiss, no diff and no Apply.
    expect(cards()[0].querySelector('a[data-knowledge-action="open-page"]')!.getAttribute('href')).toBe('#/settings/knowledge');
    expect([...cards()[0].querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Dismiss']);
    expect(cards()[0].querySelector('.knowledge-diff')).toBeNull();
    expect(bubble.isLive()).toBe(false);
    // The change was fetched once: a second render would have rebuilt the card and asked again.
    expect(calls.filter((call) => call.path === `/knowledge/changes/${ID}`)).toHaveLength(1);
  });

  it('done after the last frame has already run: the same card, as before', async () => {
    const bubble = createChatStreamBubble(chatEl());
    bubble.handle({ type: 'token', text: REPLY });
    nextFrame();
    bubble.handle(done(REPLY));
    await settle();
    nextFrame();
    await settle();
    expect(cards()).toHaveLength(1);
    expect(chatEl().textContent).not.toContain('[[knowledge:');
  });

  it('the terminal message still wins over what was streamed, and the card is for the marker it carries', async () => {
    const bubble = createChatStreamBubble(chatEl());
    bubble.handle({ type: 'token', text: 'Working on it.' });
    bubble.handle(done(REPLY));
    nextFrame();
    await settle();
    expect(chatEl().textContent).toContain('I prepared the set');
    expect(chatEl().textContent).not.toContain('Working on it.');
    expect(cards()).toHaveLength(1);
    expect((cards()[0] as HTMLElement).dataset.knowledgeChangeId).toBe(ID);
  });

  it('a render still queued when the stream fails or ends without done is harmless and the bubble stays frozen', async () => {
    const failed = createChatStreamBubble(chatEl());
    failed.handle({ type: 'token', text: 'partial' });
    failed.fail('❌ Error 400: bad');
    nextFrame();
    expect(failed.msgEl.textContent).toContain('partial');
    expect(failed.msgEl.textContent).toContain('Error 400');
    expect(failed.msgEl.classList.contains('streaming-frozen')).toBe(true);
    const cut = createChatStreamBubble(chatEl());
    cut.handle({ type: 'token', text: 'half an answer' });
    cut.finishIfLive('⚠️ Stream ended unexpectedly (no done event)');
    nextFrame();
    expect(cut.msgEl.textContent).toContain('half an answer');
    expect(cut.msgEl.textContent).toContain('Stream ended unexpectedly');
    expect(cut.isLive()).toBe(false);
  });

  it('adds no redraw, so no flicker: streaming draws once per frame, `done` draws once, and the stale frame draws nothing', () => {
    const bubble = createChatStreamBubble(chatEl());
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
    let writes = 0;
    Object.defineProperty(bubble.msgEl, 'innerHTML', {
      configurable: true,
      get(this: Element) { return original.get!.call(this); },
      set(this: Element, value: string) { writes++; original.set!.call(this, value); },
    });
    bubble.handle({ type: 'token', text: 'a' });
    bubble.handle({ type: 'token', text: 'b' });
    expect(writes).toBe(0); // queued for the next frame, not drawn yet
    nextFrame();
    expect(writes).toBe(1); // two tokens in one frame draw once
    bubble.handle({ type: 'token', text: 'c' });
    bubble.handle(done('abc'));
    expect(writes).toBe(2); // `done` draws the final bubble itself
    nextFrame();
    expect(writes).toBe(2); // the frame the last token queued draws nothing (the old code drew a third time here)
    expect(bubble.msgEl.textContent).toBe('abc');
  });

  it('a bubble that is still streaming keeps rendering on its frames', () => {
    const bubble = createChatStreamBubble(chatEl());
    bubble.handle({ type: 'token', text: 'first' });
    nextFrame();
    expect(bubble.msgEl.textContent).toContain('first');
    bubble.handle({ type: 'token', text: ' second' });
    nextFrame();
    expect(bubble.msgEl.textContent).toContain('first second');
    expect(bubble.isLive()).toBe(true);
  });
});
