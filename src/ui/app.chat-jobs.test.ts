// @vitest-environment jsdom
//
// The chat panel's owner-job surfaces (app.js, ANALYTICS_AUTONOMY_PLAN.md):
// the job strip with Stop, and continuation turns streamed live into the
// transcript through the same bubble renderer as the owner's own turns.
// Helpers are evaluated straight from the shipped source, like
// app.gmail-draft-card.test.ts.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const app = readFileSync(path.join(process.cwd(), 'src/ui/app.js'), 'utf8');

function topLevel(name: string): string {
  const start = app.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const end = app.indexOf('\n}\n', start);
  return app.slice(start, end + 2);
}

let ui: {
  renderChatJobStrip: (payload: unknown) => void;
  handleChatLiveMessage: (payload: unknown) => void;
  createChatStreamBubble: (chatEl: Element, hooks?: Record<string, unknown>) => any;
  state: { chatMessages: any[] };
};

beforeAll(() => {
  const source = [
    'let chatLiveSource = null;',
    'let chatLiveTurn = null;',
    'const state = { chatMessages: [] };',
    topLevel('escHtml'),
    topLevel('createChatStreamBubble'),
    topLevel('chatToolResultEffects'),
    topLevel('closeChatLiveBubble'),
    topLevel('handleChatLiveMessage'),
    topLevel('chatJobEsc'),
    'const chatJobDismissed = new Set();',
    topLevel('chatJobShortGoal'),
    topLevel('renderChatJobStrip'),
    'return { renderChatJobStrip, handleChatLiveMessage, createChatStreamBubble, state };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  ui = new Function(
    'formatMarkdownContent', 'hydrateChatCards', 'linkifyRenderedProjectMentions', 'refreshChatJobStrip', 'checkChatTerminal', 'requestAnimationFrame',
    source,
  )(
    (raw: string) => raw,
    () => {},
    () => {},
    async () => {},
    async () => {},
    (callback: () => void) => callback(),
  );
});

beforeEach(() => {
  document.body.innerHTML = '<div id="chat-messages"></div><div id="chat-job-strip" class="chat-job-strip" hidden></div>';
  ui.state.chatMessages.length = 0;
});

const JOB_ID = 'cj_0123456789abcdef01234567';

describe('job strip', () => {
  it('stays hidden without an active job, and for a malformed id', () => {
    ui.renderChatJobStrip({ job: null });
    expect((document.getElementById('chat-job-strip') as HTMLElement).hidden).toBe(true);
    ui.renderChatJobStrip({ job: { id: 'cj_bad"><img src=x>', status: 'active', goal: 'x' } });
    expect((document.getElementById('chat-job-strip') as HTMLElement).hidden).toBe(true);
  });

  it('shows the goal, the waiting runs, and a Stop for the job, escaping the goal', () => {
    ui.renderChatJobStrip({
      job: {
        id: JOB_ID, status: 'active', goal: 'Weekly <b>PV</b> players', continuing: false,
        waitingRuns: [{ runId: '101', purpose: 'Local weekly', remoteStatus: 'EXECUTING' }, { runId: '102' }],
      },
    });
    const strip = document.getElementById('chat-job-strip') as HTMLElement;
    expect(strip.hidden).toBe(false);
    expect(strip.querySelector('.chat-job-text')?.textContent).toBe('Working on: Weekly <b>PV</b> players');
    // The state is its own element, so a long goal never hides it.
    expect(strip.querySelector('.chat-job-state')?.textContent).toBe('waiting for 2 ETL runs');
    expect(strip.querySelector('b')).toBeNull();
    expect(strip.querySelector('.chat-job-text')?.getAttribute('title')).toContain('Run 101 (Local weekly): EXECUTING');
    expect(strip.querySelector('.chat-job-text')?.getAttribute('title')).toContain('BotBoy continues on its own when they finish.');
    expect(strip.querySelector('[data-chat-job-stop]')?.getAttribute('data-chat-job-stop')).toBe(JOB_ID);
    expect(strip.classList.contains('continuing')).toBe(false);

    ui.renderChatJobStrip({ job: { id: JOB_ID, status: 'active', goal: 'g', continuing: true, waitingRuns: [] } });
    expect(strip.querySelector('.chat-job-state')?.textContent).toBe('continuing now');
    expect(strip.classList.contains('continuing')).toBe(true);
  });

  it('nothing running reads Paused with the question, never "Working on"', () => {
    ui.renderChatJobStrip({ job: { id: JOB_ID, status: 'active', goal: 'Build the PV dashboard', phase: 'paused', pauseNote: 'Use the 2025 <i>cohort</i>?', waitingRuns: [] } });
    const strip = document.getElementById('chat-job-strip') as HTMLElement;
    expect(strip.querySelector('.chat-job-text strong')?.textContent).toBe('Paused:');
    expect(strip.querySelector('.chat-job-note')?.textContent).toBe('Use the 2025 <i>cohort</i>?');
    expect(strip.querySelector('i')).toBeNull();
    expect(strip.querySelector('.chat-job-state')?.textContent).toBe('paused, needs you');
    expect(strip.classList.contains('paused')).toBe(true);
    expect(strip.querySelector('[data-chat-job-stop]')?.textContent).toBe('End job');

    ui.renderChatJobStrip({ job: { id: JOB_ID, status: 'active', goal: 'g', phase: 'continuing', waitingRuns: [] } });
    expect(strip.querySelector('.chat-job-state')?.textContent).toBe('continuing shortly');
    expect(strip.classList.contains('paused')).toBe(false);
  });

  it('a job that just ended shows Done until dismissed', () => {
    ui.renderChatJobStrip({ job: null, recent: { id: JOB_ID, goal: 'Build it', status: 'done', endReason: 'dashboard verified' } });
    const strip = document.getElementById('chat-job-strip') as HTMLElement;
    expect(strip.hidden).toBe(false);
    expect(strip.querySelector('.chat-job-text')?.textContent).toBe('Done: Build it');
    expect(strip.querySelector('.chat-job-state')?.textContent).toBe('completed');
    expect(strip.querySelector('[data-chat-job-stop]')).toBeNull();
    expect(strip.querySelector('[data-chat-job-dismiss]')?.getAttribute('data-chat-job-dismiss')).toBe(JOB_ID);
  });
});

describe('continuation turns, live', () => {
  const chat = () => document.getElementById('chat-messages') as HTMLElement;
  const begin = (turnKey = 't1') => ui.handleChatLiveMessage({ kind: 'begin', info: { turnKey, jobId: JOB_ID, goal: 'g', note: '↻ Continued automatically: run 1 finished.', startedAt: 'now' } });

  it('renders the turn like an owner turn and freezes it on its final message', () => {
    begin();
    const bubble = chat().querySelector('.chat-msg.assistant.continuation') as HTMLElement;
    expect(bubble.classList.contains('streaming-live')).toBe(true);
    expect(bubble.textContent).toContain('↻ Continued automatically: run 1 finished.');
    ui.handleChatLiveMessage({ kind: 'event', turnKey: 't1', event: { type: 'tool_start', name: 'query_data_room', index: 0 } });
    ui.handleChatLiveMessage({ kind: 'event', turnKey: 't1', event: { type: 'tool_result', name: 'query_data_room', preview: '{"rows":3}' } });
    ui.handleChatLiveMessage({ kind: 'event', turnKey: 't1', event: { type: 'token', text: 'Imported' } });
    // Events for another turn are ignored.
    ui.handleChatLiveMessage({ kind: 'event', turnKey: 'other', event: { type: 'token', text: ' WRONG' } });
    ui.handleChatLiveMessage({ kind: 'event', turnKey: 't1', event: { type: 'done', message: { id: 'asst-9', role: 'assistant', content: '↻ Continued automatically: run 1 finished.\n\nImported the file.' } } });
    expect(bubble.classList.contains('streaming-frozen')).toBe(true);
    expect(bubble.dataset.msgId).toBe('asst-9');
    expect(bubble.textContent).toContain('Imported the file.');
    expect(bubble.textContent).not.toContain('WRONG');
    expect(bubble.querySelector('.tool-card-standalone.tool-done')).not.toBeNull();
    expect(ui.state.chatMessages.map(message => message.id)).toEqual(['asst-9']);
    // The end of a finished turn keeps its bubble.
    ui.handleChatLiveMessage({ kind: 'end', turnKey: 't1' });
    expect(chat().querySelectorAll('.chat-msg')).toHaveLength(1);
  });

  it('a replay after a reconnect starts the live bubble over instead of duplicating it', () => {
    begin();
    ui.handleChatLiveMessage({ kind: 'event', turnKey: 't1', event: { type: 'token', text: 'Part one' } });
    begin();
    ui.handleChatLiveMessage({ kind: 'event', turnKey: 't1', event: { type: 'token', text: 'Part one' } });
    expect(chat().querySelectorAll('.chat-msg')).toHaveLength(1);
    expect(chat().textContent?.match(/Part one/g)).toHaveLength(1);
  });

  it('an unfinished turn that ends gives way to the persisted reply', () => {
    begin();
    ui.handleChatLiveMessage({ kind: 'event', turnKey: 't1', event: { type: 'token', text: 'partial' } });
    ui.handleChatLiveMessage({ kind: 'end', turnKey: 't1' });
    expect(chat().querySelectorAll('.chat-msg')).toHaveLength(0);
  });
});

describe('stream bubble', () => {
  it('shows a failure line, and the no-done safety net only once', () => {
    const bubble = ui.createChatStreamBubble(document.getElementById('chat-messages')!);
    bubble.handle({ type: 'status', text: 'Thinking...' });
    bubble.handle({ type: 'token', text: 'Hello' });
    expect(bubble.msgEl.textContent).toBe('Hello');
    bubble.finishIfLive('⚠️ Stream ended unexpectedly (no done event)');
    bubble.finishIfLive('⚠️ again');
    expect(bubble.msgEl.textContent).toBe('Hello⚠️ Stream ended unexpectedly (no done event)');
    expect(bubble.isLive()).toBe(false);
    const failed = ui.createChatStreamBubble(document.getElementById('chat-messages')!);
    failed.fail('❌ Error 400: bad');
    expect(failed.msgEl.classList.contains('streaming-frozen')).toBe(true);
  });
});
