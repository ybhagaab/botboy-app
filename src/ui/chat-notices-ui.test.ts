// @vitest-environment jsdom
//
// Compact chat notices (chat-notices-ui.js, MIDWAY_NOTICES_PLAN.md §6): BotBoy's own status rows drawn as one small line with a
// status dot, labels, the time and a chevron; details on a click; consecutive notices about one thing folded together; a fixed
// problem quiet. The module and app.js's transcript renderer and stream bubble are evaluated straight from the shipped sources.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const read = (name: string) => readFileSync(path.join(process.cwd(), 'src/ui', name), 'utf8');
const app = read('app.js');
const noticesSource = read('chat-notices-ui.js');
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

let N: any;
let state: { chatMessages: any[] };
let renderChat: () => void;
let createChatStreamBubble: (chatEl: Element, hooks?: Record<string, unknown>) => any;
let renderChatMsgInner: (m: any) => string;
let afterReauth: ReturnType<typeof vi.fn>;
const md = (text: string) => `<div class="md">${String(text).replace(/</g, '&lt;')}</div>`;

beforeAll(() => {
  // eslint-disable-next-line no-new-func
  new Function(noticesSource)();
  N = (window as any).BotBoyNotices;
  state = { chatMessages: [] };
  const source = [
    constLine('JOB_CARD_ONLY_RE'), constLine('JOB_ROW_RE'), constLine('WHATSAPP_NOTE_RE'), topLevel('chatRowClass'),
    constLine('JOB_UPDATE_RE'), constLine('JOB_REPORT_FOLD_CHARS'), constLine('JOB_REPORT_FOLD_LINES'),
    topLevel('escHtml'), topLevel('renderChatMsgInner'), topLevel('renderChat'), topLevel('createChatStreamBubble'),
    'return { renderChat, createChatStreamBubble, renderChatMsgInner };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  ({ renderChat, createChatStreamBubble, renderChatMsgInner } = new Function(
    'state', 'formatMarkdownContent', 'thinkingTextHtml', 'escAttr', 'linkifyRenderedProjectMentions', 'hydrateChatCards', 'requestAnimationFrame',
    source,
  )(state, md, (text: string) => text, (text: string) => text, () => {}, () => {}, (callback: () => void) => callback()));
});

beforeEach(() => {
  document.body.innerHTML = '<div id="chat-panel"><div id="chat-messages"></div></div>';
  state.chatMessages = [];
  N._test.expanded.clear();
  N._test.actionNotes.clear();
  afterReauth = vi.fn(async () => {});
  N.init({ apiBase: '/api', markdown: md, afterReauth });
});

const at = (hh: number, mm: number) => new Date(Date.UTC(2026, 9, 29, hh, mm)).toISOString();
const structured = (id: string, fields: Record<string, unknown>, createdAt = at(2, 0)) => ({
  id, role: 'assistant', content: `${fields.title}.`, createdAt,
  notice: { v: 1, key: 'midway', topic: 'midway', state: 'open', severity: 'warning', labels: [], ...fields },
});
const SIGN_IN = (id = 'n1', createdAt = at(2, 0)) => structured(id, {
  title: 'Midway sign-in needed', labels: ['GRASP', 'Slack'], next: 'Run mwinit. Capture catches up on its own afterwards.',
  detail: 'Your Midway session expired at 12:06 PM.\nSigning in has failed since 12:06 PM.', action: { kind: 'midway_reauth', label: 'Re-authenticate' },
}, createdAt);
const FIXED = (id = 'n2', createdAt = at(3, 0)) => structured(id, { state: 'resolved', severity: 'success', title: 'Amazon sign-in working again', labels: ['GRASP'], detail: 'Working again at 1:10 PM.' }, createdAt);
const text = (id: string, role: string, content: string, createdAt = at(2, 30)) => ({ id, role, content, createdAt });
const messages = () => document.getElementById('chat-messages')!;

describe('recognising older rows and the chat route\'s fixed texts', () => {
  const legacy = (content: string) => N._test.legacyNotice(content);

  it('turn failures keep the reason as detail and the closing sentence as the next step', () => {
    expect(legacy('⚠ This turn failed before I could finish: HTTP 400: {"error":{"message":"Payload size of 9 MB exceeds the allowed limit"}}. Any file edits or runs I completed before the failure are still in place. Please resend your message to continue.'))
      .toMatchObject({ key: 'turn-failed', severity: 'error', title: 'This turn failed', labels: ['HTTP 400'], next: 'Resend your message to continue.', detail: 'HTTP 400: {"error":{"message":"Payload size of 9 MB exceeds the allowed limit"}}' });
    expect(legacy('⚠️ This turn failed before I could finish: fetch failed. Any file edits or runs I completed are in place, and the work carries on as a job by itself.'))
      .toMatchObject({ labels: ['Network'], next: 'The work carries on as a job by itself.', detail: 'fetch failed' });
    expect(legacy('↻ Continued automatically: run 1 finished (3 rows).\n\n⚠️ This automatic turn failed before I could finish: Request timed out. Work completed before the failure is in place.'))
      .toMatchObject({ title: 'Automatic turn failed', labels: ['Timed out'], next: 'Work done before the failure is kept.', detail: '↻ Continued automatically: run 1 finished (3 rows).\nRequest timed out' });
  });

  it('provider waits, stops and pauses', () => {
    expect(legacy('⏳ The AI provider asked BotBoy to slow down. This work waits its turn and carries on by itself; nothing done so far is lost.')).toMatchObject({ severity: 'info', title: 'AI provider busy' });
    expect(legacy('↻ Continued automatically: the job\'s next step.\n\n⏳ BotBoy couldn\'t reach the AI model (fetch failed (ENOTFOUND)). This work waits and carries on by itself when the connection is back; nothing done so far is lost.'))
      .toMatchObject({ key: 'provider', severity: 'warning', title: 'AI model unreachable', labels: ['Network'], next: 'This work waits and carries on by itself when the connection is back.', detail: '↻ Continued automatically: the job\'s next step.\nfetch failed (ENOTFOUND)' });
    expect(legacy('⏳ The AI provider is limiting requests right now (429 Too Many Requests). Please send your message again in a minute.'))
      .toMatchObject({ severity: 'warning', title: 'AI provider limiting requests', next: 'Send your message again in a minute.', detail: '429 Too Many Requests' });
    expect(legacy('⏹️ Stopped at your request. Work already completed is preserved; tell me when to continue.')).toMatchObject({ key: 'stop', title: 'Stopped' });
    expect(legacy('⏹ Stopped at your request. The work done so far is preserved above; tell me when to continue.')).toMatchObject({ title: 'Stopped' });
    expect(legacy('⏹ Stopped because the AI model was changed in Settings. Work already completed is preserved; send your message again to continue on the new model.')).toMatchObject({ title: 'Stopped: AI model changed' });
    expect(legacy('⏹ Stopped: you ended this job. Work already done is kept.')).toMatchObject({ title: 'Job stopped' });
    expect(legacy('⏸ Paused: you paused this job. Work already done is kept; resume it from the job menu, or reply here.')).toMatchObject({ title: 'Job paused' });
    expect(legacy('↻ Paused this automatic continuation because you sent a message. The job continues from your message.')).toMatchObject({ title: 'Automatic turn paused' });
  });

  it('terminal endings, startup failures, dashboard diagnoses and the old Midway rows', () => {
    expect(legacy('🖥 Terminal update: “Install pdftotext (Poppler)” ended with status **failed** (exit code 18). Ask me to check the result if you want it verified.'))
      .toMatchObject({ key: 'terminal', severity: 'warning', title: 'Terminal ended', labels: ['Install pdftotext (Poppler)', 'Failed (exit 18)'] });
    expect(legacy('🖥 Terminal update: “Midway authentication” ended with status **completed** (exit code 0). Ask me to check the result if you want it verified.'))
      .toMatchObject({ severity: 'info', title: 'Terminal finished', labels: ['Midway authentication', 'Done'] });
    expect(legacy('⚠ Slack sync did not start with the app (spawn ENOENT). The dashboard keeps working; check the Connections page or ask me to run a diagnosis.'))
      .toMatchObject({ topic: 'startup', severity: 'error', title: "Slack sync didn't start", labels: ['Slack sync'], detail: 'spawn ENOENT' });
    const dashboard = legacy('🔎 **Dashboard refresh diagnostics** — "MX Android → Prime Player": 2 widget(s) still failed after the cross-lane retry.\n\n**Cause:** the view was dropped.\n\n[[lesson:lesson_abc123]]\n\n_Automatic escalation from run run_1 (schedule, local lane)._');
    expect(dashboard).toMatchObject({ key: 'dashboard:MX Android → Prime Player', severity: 'error', title: 'Dashboard refresh failed', labels: ['MX Android → Prime Player', '2 widgets'], detailMarkdown: true });
    expect(dashboard.detail).toContain('[[lesson:lesson_abc123]]'); // the lesson card still expands in the details
    expect(legacy('Midway is refreshed. Microsoft 365 (GRASP), Slack, and Prime Video Agent Edge are running, compatible, and ready to use.'))
      .toMatchObject({ key: 'midway', state: 'resolved', title: 'Amazon sign-in working again', labels: ['GRASP', 'Slack'] });
    expect(legacy('🔐 Your Amazon session needs re-authentication, which disconnected: Amazon Microsoft 365 through GRASP. Use the terminal card below to run mwinit (PIN + security-key touch).'))
      .toMatchObject({ key: 'midway', state: 'open', title: 'Midway sign-in needed', labels: ['GRASP'], action: null });
  });

  it('never mistakes a reply for a notice', () => {
    expect(legacy('❌ **Still timing out** — the MCP connection is unstable despite showing as "running."\n\n## Diagnosis')).toBeNull();
    expect(legacy('⏹️ Stopped at your request. Work already completed is preserved; tell me when to continue.\n\n[[job:cj_aaaaaaaaaaaaaaaaaaaaaaaa:started]]')).toBeNull();
    expect(legacy(`⏹️ Stopped at your request. ${'More words. '.repeat(40)}`)).toBeNull();
    expect(legacy('Midway is the name of the atoll.')).toBeNull();
    expect(N.noticeOf({ role: 'user', content: '⏹ Stopped: you ended this job. Work already done is kept.' })).toBeNull();
  });

  it('a structured notice is checked again in the panel: unknown actions and outside routes are dropped', () => {
    expect(N.noticeOf({ role: 'assistant', content: 'x', notice: { title: 'T', state: 'open', severity: 'loud' } })).toBeNull();
    const n = N.noticeOf({ role: 'assistant', content: 'x', notice: { key: 'k', topic: 'connection', title: 'T', state: 'open', severity: 'warning', action: { kind: 'open_route', label: 'Open', route: 'javascript:alert(1)' } } });
    expect(n.action).toBeNull();
  });
});

describe('grouping', () => {
  it('folds consecutive notices about one thing, splits on any other row, and quiets an open notice a later fix answered', () => {
    const items = N._test.itemsOf([
      SIGN_IN('a'), structured('b', { title: 'Midway sign-in needed', labels: ['GRASP'] }),
      text('u1', 'user', 'hi'),
      FIXED('c'),
      structured('d', { key: 'connection:slack', topic: 'connection', title: 'Slack not responding' }),
    ]);
    expect(items.map((item: any) => item.entries ? item.entries.map((entry: any) => entry.m.id).join('+') : item.message.id)).toEqual(['a+b', 'u1', 'c', 'd']);
    expect(items[0].settledAt?.toISOString()).toBe(at(3, 0));
    expect(items[2].settledAt).toBeNull();
    expect(items[3].settledAt).toBeNull();
  });
});

describe('the main transcript', () => {
  it('draws notices as compact lines with no bubble, and keeps ordinary rows as they were', () => {
    state.chatMessages = [text('u1', 'user', 'Check my mail'), SIGN_IN('n1'), text('a1', 'assistant', 'Here is the summary.')];
    renderChat();
    const rows = [...messages().children] as HTMLElement[];
    expect(rows.map(row => row.className)).toEqual(['chat-msg user', 'chat-msg assistant notice-row', 'chat-msg assistant']);
    const box = rows[1].querySelector('.chat-notice')!;
    expect(box.className).toBe('chat-notice sev-warning');
    expect(box.querySelector('.chat-notice-title')!.textContent).toBe('Midway sign-in needed');
    expect([...box.querySelectorAll('.chat-notice-label')].map(label => label.textContent)).toEqual(['GRASP', 'Slack']);
    expect(box.querySelector('.chat-notice-time')!.getAttribute('datetime')).toBe(at(2, 0));
    expect(box.querySelector('[data-notice-action="midway_reauth"]')!.textContent).toBe('Re-authenticate');
    expect(box.querySelector('.chat-notice-next-inline')).toBeNull(); // the button is the next step
    expect(box.querySelector('.chat-notice-count')).toBeNull(); // one notice has no count
    expect(box.classList.contains('expanded')).toBe(false);
    expect(rows[1].dataset.msgId).toBe('n1');
  });

  it('opens on a click, stays open across a repaint, and closes again', () => {
    state.chatMessages = [SIGN_IN('n1')];
    renderChat();
    const head = () => messages().querySelector<HTMLButtonElement>('[data-notice-toggle]')!;
    head().click();
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(messages().querySelector('.chat-notice')!.classList.contains('expanded')).toBe(true);
    expect(messages().querySelector('.chat-notice-next')!.textContent).toBe('Run mwinit. Capture catches up on its own afterwards.');
    expect([...messages().querySelectorAll('.chat-notice-detail p')].map(p => p.textContent)).toEqual(['Your Midway session expired at 12:06 PM.', 'Signing in has failed since 12:06 PM.']);
    renderChat();
    expect(messages().querySelector('.chat-notice')!.classList.contains('expanded')).toBe(true);
    head().click();
    expect(messages().querySelector('.chat-notice')!.classList.contains('expanded')).toBe(false);
  });

  it('a fix right after the problem folds both into one quiet "working again" line with a timeline', () => {
    state.chatMessages = [SIGN_IN('n1'), FIXED('n2')];
    renderChat();
    const rows = messages().querySelectorAll('.chat-msg');
    expect(rows).toHaveLength(1);
    const box = rows[0].querySelector('.chat-notice')!;
    expect(box.className).toBe('chat-notice fixed');
    expect(box.querySelector('.chat-notice-title')!.textContent).toBe('Amazon sign-in working again');
    expect(box.querySelector('.chat-notice-action')).toBeNull();
    // Labels show in the timeline only where they differ from the notice's own line.
    expect([...box.querySelectorAll('.chat-notice-timeline li span')].map(span => span.textContent)).toEqual([
      'Midway sign-in needed · GRASP, Slack', 'Amazon sign-in working again',
    ]);
    expect((rows[0] as HTMLElement).dataset.noticeIds).toBe('n1 n2');
  });

  it('after a sign-in (midway-sentinel.md S2) the "Signed in again" line names what is being checked with no button, and the result folds it to fixed', () => {
    const SEEN = structured('n2', {
      state: 'info', severity: 'info', title: 'Signed in again', labels: ['Slack', 'SharePoint'], next: 'Checking Slack and SharePoint now.',
      detail: 'Signed in again at 10:59 PM.\nAlready working: GRASP.',
    }, at(2, 30));
    state.chatMessages = [SIGN_IN('n1'), SEEN];
    renderChat();
    expect(messages().querySelectorAll('.chat-msg')).toHaveLength(1);
    let box = messages().querySelector('.chat-notice')!;
    expect(box.className).toBe('chat-notice sev-info');
    expect(box.querySelector('.chat-notice-title')!.textContent).toBe('Signed in again');
    expect([...box.querySelectorAll('.chat-notice-label')].map(label => label.textContent)).toEqual(['Slack', 'SharePoint']);
    expect(box.querySelector('.chat-notice-action')).toBeNull();

    state.chatMessages = [SIGN_IN('n1'), SEEN, FIXED('n3', at(3, 10))];
    renderChat();
    box = messages().querySelector('.chat-notice')!;
    expect(box.className).toBe('chat-notice fixed');
    expect((messages().querySelector('.chat-msg') as HTMLElement).dataset.noticeIds).toBe('n1 n2 n3');
  });

  it('a fix later in the conversation quiets the earlier notice: no button, a "Fixed" label', () => {
    state.chatMessages = [SIGN_IN('n1'), text('u1', 'user', 'ok'), text('a1', 'assistant', 'Done.'), FIXED('n2')];
    renderChat();
    const first = messages().querySelector('.chat-notice')!;
    expect(first.className).toBe('chat-notice quiet');
    expect(first.querySelector('.chat-notice-action')).toBeNull();
    expect(first.querySelector('.fixed-label')!.textContent).toMatch(/^Fixed /);
  });

  it('repeats of one notice show a count', () => {
    const failed = (id: string) => text(id, 'assistant', '🔎 **Dashboard refresh diagnostics** — "Weekly": 1 widget(s) still failed after the cross-lane retry.\n\nThe view was dropped.');
    state.chatMessages = [failed('d1'), failed('d2'), failed('d3')];
    renderChat();
    expect(messages().querySelectorAll('.chat-msg')).toHaveLength(1);
    expect(messages().querySelector('.chat-notice-count')!.textContent).toBe('×3');
    expect(messages().querySelector('.chat-notice-detail.content-block')).not.toBeNull(); // Markdown detail through the safe renderer
  });

  it('a failure without a button shows its next step on the line itself', () => {
    state.chatMessages = [text('f1', 'assistant', '⚠ This turn failed before I could finish: fetch failed. Any file edits or runs I completed before the failure are still in place. Please resend your message to continue.')];
    renderChat();
    expect(messages().querySelector('.chat-notice')!.className).toBe('chat-notice sev-error');
    expect(messages().querySelector('.chat-notice-next-inline')!.textContent).toBe('Resend your message to continue.');
  });

  it('escapes everything a row carries', () => {
    state.chatMessages = [structured('x1', { title: '<img src=x onerror=alert(1)>', labels: ['<b>GRASP</b>'], detail: '<script>alert(1)</script>' })];
    renderChat();
    expect(messages().querySelector('img, b, script')).toBeNull();
    expect(messages().querySelector('.chat-notice-title')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('after a turn (frozen bubbles stay), a new notice joins the one above it and ids are never drawn twice', () => {
    messages().innerHTML = '<div class="chat-msg assistant streaming-frozen" data-msg-id="t1"><div class="content-block">Reply</div></div>';
    state.chatMessages = [text('t1', 'assistant', 'Reply'), SIGN_IN('n1')];
    renderChat();
    expect(messages().querySelectorAll('.notice-row')).toHaveLength(1);
    state.chatMessages = [...state.chatMessages, FIXED('n2')];
    renderChat();
    const rows = messages().querySelectorAll<HTMLElement>('.notice-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.chat-notice')!.className).toBe('chat-notice fixed');
    renderChat();
    expect(messages().querySelectorAll('.chat-msg')).toHaveLength(2);
    expect(rows[0].dataset.noticeIds).toBe('n1 n2'); // the earlier row was not drawn again
    expect(rows[0].querySelectorAll('.chat-notice-timeline li')).toHaveLength(2);
    // A notice about something else starts its own line.
    state.chatMessages = [...state.chatMessages, structured('s1', { key: 'connection:slack', topic: 'connection', title: 'Slack not responding', labels: ['Slack'] })];
    renderChat();
    expect([...messages().querySelectorAll<HTMLElement>('.notice-row')].map(row => row.dataset.noticeIds)).toEqual(['n1 n2', 's1']);
  });

  it('after a turn, a fix that arrives later quiets the open notice above the conversation', () => {
    messages().innerHTML = '<div class="chat-msg assistant streaming-frozen" data-msg-id="t1"><div class="content-block">Reply</div></div>';
    state.chatMessages = [text('t1', 'assistant', 'Reply'), SIGN_IN('n1')];
    renderChat();
    state.chatMessages = [...state.chatMessages, text('u2', 'user', 'thanks'), FIXED('n2')];
    renderChat();
    const boxes = messages().querySelectorAll('.chat-notice');
    expect([...boxes].map(box => box.className)).toEqual(['chat-notice quiet', 'chat-notice fixed']);
  });
});

describe('a job\'s thread', () => {
  it('draws each notice row on its own (the thread renders rows one by one), and ordinary rows as before', () => {
    const html = renderChatMsgInner(text('j1', 'assistant', '⏹ Stopped: you ended this job. Work already done is kept.'));
    const holder = document.createElement('div');
    holder.innerHTML = `<div class="chat-msg assistant">${html}</div>`;
    expect(holder.querySelector('.chat-msg > .chat-notice:only-child .chat-notice-title')!.textContent).toBe('Job stopped');
    expect(renderChatMsgInner(text('j2', 'assistant', 'Here is the table.'))).toContain('<div class="content-block">');
  });
});

describe('Re-authenticate', () => {
  it('opens the terminal through the owner route, then shows the dock; a busy terminal says why', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    let reply: { status: number; body: unknown } = { status: 200, body: { ok: true, sessionId: 'term-1', command: 'mwinit' } };
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    });
    state.chatMessages = [SIGN_IN('n1')];
    renderChat();
    const button = () => messages().querySelector<HTMLButtonElement>('[data-notice-action="midway_reauth"]')!;
    button().click();
    await vi.waitFor(() => expect(afterReauth).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([{ url: '/api/chat/midway-reauth', init: expect.objectContaining({ method: 'POST' }) }]);
    expect(messages().querySelector('.chat-notice-status')!.textContent).toBe('The mwinit terminal is open below.');
    expect(messages().querySelector('.chat-notice')!.classList.contains('expanded')).toBe(false); // the button does not toggle
    reply = { status: 409, body: { ok: false, code: 'terminal_busy', error: 'A terminal is already running in the chat. Finish or stop it, then press Re-authenticate again.' } };
    button().click();
    await vi.waitFor(() => expect(messages().querySelector('.chat-notice-status')!.textContent).toMatch(/already running/));
    expect(afterReauth).toHaveBeenCalledTimes(1);
    renderChat();
    expect(messages().querySelector('.chat-notice-status')!.textContent).toMatch(/already running/); // kept across a repaint
  });

  it('a GRASP notice links to the GRASP page instead; the link opens its page and never toggles the notice', () => {
    state.chatMessages = [structured('g1', { title: 'GRASP sign-in lost', labels: [], action: { kind: 'open_route', label: 'Open GRASP', route: '#/connections/grasp-m365' } })];
    renderChat();
    const link = messages().querySelector<HTMLAnchorElement>('a.chat-notice-action')!;
    expect(link.getAttribute('href')).toBe('#/connections/grasp-m365');
    expect(link.textContent).toBe('Open GRASP');
    const clicked = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(clicked);
    expect(clicked.defaultPrevented).toBe(false);
    expect(messages().querySelector('.chat-notice')!.classList.contains('expanded')).toBe(false);
  });

  it('the labels line toggles too, and the button beside it does not', async () => {
    (globalThis as any).fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, command: 'mwinit' }), { status: 200 }));
    state.chatMessages = [SIGN_IN('n1')];
    renderChat();
    const box = () => messages().querySelector('.chat-notice')!;
    messages().querySelector<HTMLElement>('.chat-notice-label')!.click();
    expect(box().classList.contains('expanded')).toBe(true);
    expect(box().querySelector('.chat-notice-head')!.getAttribute('aria-expanded')).toBe('true');
    messages().querySelector<HTMLButtonElement>('[data-notice-action]')!.click();
    expect(box().classList.contains('expanded')).toBe(true);
    await vi.waitFor(() => expect(afterReauth).toHaveBeenCalled());
  });
});

describe('the stream bubble', () => {
  it('an HTTP refusal, a dropped stream and an error event read as notices', () => {
    const chat = messages();
    const refused = createChatStreamBubble(chat);
    refused.fail('⚠️ No AI model is connected. Open Settings → AI model.', { error: 'No AI model is connected.', nextAction: 'Open Settings → AI model.' });
    expect(refused.msgEl.querySelector('.chat-notice-title')!.textContent).toBe('No AI model is connected.');
    expect(refused.msgEl.querySelector('.chat-notice-next-inline')!.textContent).toBe('Open Settings → AI model.');
    const http = createChatStreamBubble(chat);
    http.fail('❌ Error 502: Bad gateway');
    expect(http.msgEl.querySelector('.chat-notice-title')!.textContent).toBe('Message not sent');
    expect(http.msgEl.querySelector('.chat-notice-label')!.textContent).toBe('HTTP 502');
    const dropped = createChatStreamBubble(chat);
    dropped.finishIfLive('⚠️ Stream ended unexpectedly (no done event)');
    expect(dropped.msgEl.querySelector('.chat-notice-title')!.textContent).toBe('Reply cut off');
    const errored = createChatStreamBubble(chat);
    errored.handle({ type: 'error', error: 'socket hang up' });
    expect(errored.msgEl.querySelector('.chat-notice-title')!.textContent).toBe('Reply failed');
    expect(errored.isLive()).toBe(false);
  });

  it('a turn that ends with the route\'s failure text shows the notice after its tool cards; a normal reply stays prose', () => {
    const chat = messages();
    const failed = createChatStreamBubble(chat);
    failed.handle({ type: 'tool_start', index: 0, name: 'query_db' });
    failed.handle({ type: 'token', text: 'Checking…' });
    failed.handle({ type: 'done', message: { id: 'asst-1', role: 'assistant', content: '⚠️ This turn failed before I could finish: HTTP 500: upstream. Any file edits or runs I completed are in place, and the work carries on as a job by itself.' } });
    expect(failed.msgEl.querySelector('.tool-card-standalone')).not.toBeNull();
    expect(failed.msgEl.querySelector('.chat-notice')!.getAttribute('data-notice-group')).toBe('asst-1');
    expect(failed.msgEl.querySelector('.chat-notice-label')!.textContent).toBe('HTTP 500');
    const ok = createChatStreamBubble(chat);
    ok.handle({ type: 'token', text: 'Hello' });
    ok.handle({ type: 'done', message: { id: 'asst-2', role: 'assistant', content: 'Hello there.' } });
    expect(ok.msgEl.querySelector('.chat-notice')).toBeNull();
    expect(ok.msgEl.querySelector('.content-block')!.textContent).toContain('Hello there.');
  });
});
