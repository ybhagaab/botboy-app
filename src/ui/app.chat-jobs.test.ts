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
const css = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.css'), 'utf8');

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
    topLevel('setChatJobStripState'),
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

// Owner request 2026-10-16: the strip's BORDER tells the job's state. Running: a faint light travels around it. Paused: all
// yellow, still. Finished: all green, still. A job the owner stopped, or that expired, did not finish, so it stays neutral.
describe('job strip border states', () => {
  const strip = () => document.getElementById('chat-job-strip') as HTMLElement;
  /** The state classes on the strip, alphabetical, so each case reads as the set it expects. */
  const states = () => ['continuing', 'done', 'ended', 'paused', 'running'].filter((name) => strip().classList.contains(name));
  const active = (over: Record<string, unknown> = {}) => ({ job: { id: JOB_ID, status: 'active', goal: 'g', waitingRuns: [], ...over } });
  const ended = (status: string) => ({ job: null, recent: { id: JOB_ID, goal: 'g', status, endReason: 'x' } });

  it('every unpaused phase is running: working, continuing now, continuing shortly, waiting for a run, and a server that sends no phase', () => {
    ui.renderChatJobStrip(active({ phase: 'working' }));
    expect(states()).toEqual(['running']);
    ui.renderChatJobStrip(active({ phase: 'working', continuing: true }));
    expect(states()).toEqual(['continuing', 'running']); // the dot pulse (continuing) and the travelling light go together
    ui.renderChatJobStrip(active({ phase: 'continuing' }));
    expect(states()).toEqual(['running']);
    ui.renderChatJobStrip(active({ phase: 'waiting', waitingRuns: [{ runId: '101' }] }));
    expect(states()).toEqual(['running']); // BotBoy is still on it: it continues by itself when the run finishes
    ui.renderChatJobStrip(active({ waitingRuns: [{ runId: '101' }] })); // older servers: the phase is derived
    expect(states()).toEqual(['running']);
    ui.renderChatJobStrip(active());
    expect(states()).toEqual(['running']);
  });

  it('a paused job is paused and nothing else: yellow, and not running', () => {
    ui.renderChatJobStrip(active({ phase: 'paused', pauseNote: 'Review it.' }));
    expect(states()).toEqual(['paused']);
  });

  it('a finished job is done (green); one that was stopped, expired or otherwise ended is neutral, never green', () => {
    ui.renderChatJobStrip(ended('done'));
    expect(states()).toEqual(['done', 'ended']);
    for (const status of ['stopped', 'expired', 'replaced']) {
      ui.renderChatJobStrip(ended(status));
      expect(states(), status).toEqual(['ended']);
    }
  });

  it('every change of state leaves exactly its own classes, and hiding the strip clears them, so a stale ring never comes back', () => {
    ui.renderChatJobStrip(active({ phase: 'working', continuing: true }));
    expect(states()).toEqual(['continuing', 'running']);
    ui.renderChatJobStrip(active({ phase: 'paused' }));
    expect(states()).toEqual(['paused']);
    ui.renderChatJobStrip(active({ phase: 'working' }));
    expect(states()).toEqual(['running']);
    ui.renderChatJobStrip(ended('done'));
    expect(states()).toEqual(['done', 'ended']);
    ui.renderChatJobStrip(ended('stopped'));
    expect(states()).toEqual(['ended']);
    ui.renderChatJobStrip({ job: null, recent: null });
    expect(strip().hidden).toBe(true);
    expect(states()).toEqual([]);
    ui.renderChatJobStrip(active({ phase: 'paused' }));
    expect(states()).toEqual(['paused']);
    ui.renderChatJobStrip({ job: null });
    expect(states()).toEqual([]);
  });

  it('rendering the same state again changes no attribute of the strip, so the travelling light is not restarted by the 5 s re-render', () => {
    ui.renderChatJobStrip(active({ phase: 'working' }));
    const observer = new MutationObserver(() => undefined);
    observer.observe(strip(), { attributes: true });
    ui.renderChatJobStrip(active({ phase: 'working' }));
    ui.renderChatJobStrip(active({ phase: 'working', goal: 'a goal that now reads differently' })); // the children change, the state does not
    ui.renderChatJobStrip(active({ phase: 'waiting', waitingRuns: [{ runId: '7' }] })); // another phase, still running
    expect(observer.takeRecords()).toEqual([]);
    // The strip was not simply left alone: its children were rewritten each time (the last render was the waiting phase).
    expect(strip().querySelector('.chat-job-state')?.textContent).toBe('waiting for 1 ETL run');
    ui.renderChatJobStrip(active({ phase: 'paused' })); // a real change is seen
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    observer.disconnect();
  });
});

// jsdom has no layout and runs no animation, so the motion and the colours are pinned on the stylesheet itself.
describe('job strip border states: the stylesheet', () => {
  const stripCss = () => {
    const from = css.indexOf('/* Owner job strip:');
    const to = css.indexOf('.chat-msg.assistant.continuation', from);
    expect(from, 'missing the job strip block').toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    return css.slice(from, to);
  };
  const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declarations = (source: string, selector: string): Record<string, string> => {
    const match = source.match(new RegExp(`(?:^|\\n)${escapeRe(selector)} \\{([^}]*)\\}`));
    expect(match, `missing the rule for ${selector}`).not.toBeNull();
    return Object.fromEntries(match![1].split(';').map((part) => part.trim()).filter(Boolean).map((part) => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim()]));
  };
  const tokens = (start: string): Record<string, string> => {
    const from = css.indexOf(start);
    expect(from, `missing ${start}`).toBeGreaterThanOrEqual(0);
    const body = css.slice(css.indexOf('{', from) + 1, css.indexOf('}', from));
    return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
  };
  const rgb = (value: string): number[] => {
    const match = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    expect(match, `not a hex colour: ${value}`).not.toBeNull();
    const hex = match![1].length === 3 ? [...match![1]].map((digit) => digit + digit).join('') : match![1];
    return [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
  };
  const luminance = (colour: number[]) => {
    const [r, g, b] = colour.map((channel) => { const s = channel / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it('only the running ring moves: paused and done declare no animation, and the strip has exactly two animated rules', () => {
    const source = stripCss();
    for (const selector of ['.chat-job-strip.paused', '.chat-job-strip.done']) expect(declarations(source, selector), selector).not.toHaveProperty('animation');
    const animated = [...source.matchAll(/(?:^|\n)([^\n{]+?) \{[^}]*\banimation:\s*(?!none)[^;}]+/g)].map((match) => match[1].trim());
    expect(animated).toEqual(['.chat-job-strip.continuing .chat-job-dot', '.chat-job-strip.running::before']);
  });

  it('the light is painted on a masked 2px ring, so it can only show on the border, and it never blocks a click', () => {
    const ring = declarations(stripCss(), '.chat-job-strip.running::before');
    expect(ring).toMatchObject({ position: 'absolute', inset: '-1px', padding: '2px', 'pointer-events': 'none', 'mask-composite': 'exclude', animation: 'chat-job-orbit 8s linear infinite' });
    expect(ring.mask).toContain('content-box');
    expect(ring['border-radius']).toBe('inherit'); // the ring follows the strip's rounded corners
    expect(declarations(stripCss(), '.chat-job-strip.running')['border-color']).toContain('var(--job-run)');
  });

  it('the light makes a closed loop: it starts and ends in the same corner and visits all four', () => {
    const match = css.match(/@keyframes chat-job-orbit \{([\s\S]*?)\n\}/);
    expect(match, 'missing the keyframes').not.toBeNull();
    const frames = [...match![1].matchAll(/(\d+(?:\.\d+)?)%\s*\{\s*background-position:([^;]+);/g)].map((frame) => [Number(frame[1]), frame[2].trim()] as const);
    expect(frames.map(([at]) => at)).toEqual([0, 45, 50, 95, 100]);
    expect(frames[0][1]).toBe(frames[4][1]);
    expect(new Set(frames.map(([, position]) => position)).size).toBe(4);
  });

  it('with reduced motion nothing travels, and the running ring stays lit so the state still reads', () => {
    const media = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.chat-job-strip\.continuing \.chat-job-dot \{ animation:none; \}\s*\n\s*\.chat-job-strip\.running::before \{([^}]*)\}/);
    expect(media, 'missing the reduced-motion rule for the ring').not.toBeNull();
    expect(media![1]).toContain('animation:none');
    expect(media![1]).toMatch(/background:color-mix\(in srgb, var\(--job-run\)/);
  });

  it('the light stops while the chat panel is closed: the panel hides by sliding off-screen, so without this a running job animates unseen', () => {
    const hidden = declarations(stripCss(), '#chat-panel.hidden .chat-job-strip.running::before');
    expect(hidden).toEqual({ 'animation-play-state': 'paused' });
    // The panel really hides by class and transform, not display:none (which would make the rule unnecessary).
    expect(css).toMatch(/#chat-panel\.hidden \{ transform:translateX\(100%\)/);
    expect(css).not.toMatch(/#chat-panel\.hidden \{[^}]*display:\s*none/);
    // It must come AFTER the rule that starts the animation, and an id selector outranks the strip's class selectors.
    const source = stripCss();
    expect(source.indexOf('#chat-panel.hidden .chat-job-strip.running::before')).toBeGreaterThan(source.indexOf('animation:chat-job-orbit 8s linear infinite'));
  });

  it('the state rules come after the base rule (they tie with it on specificity), and a finished strip shows the done dot over the ended one', () => {
    const source = stripCss();
    const base = source.indexOf('.chat-job-strip:not([hidden]) {');
    expect(base).toBeGreaterThanOrEqual(0);
    for (const selector of ['.chat-job-strip.running {', '.chat-job-strip.paused {', '.chat-job-strip.done {']) expect(source.indexOf(selector), selector).toBeGreaterThan(base);
    expect(source.indexOf('.chat-job-strip.done .chat-job-dot')).toBeGreaterThan(source.indexOf('.chat-job-strip.ended .chat-job-dot'));
  });

  it('the yellow and green rings keep 3:1 against the strip in both themes (a light theme has its own gold ring token, because its --yellow is a dark amber made for text)', () => {
    const source = stripCss();
    const dark = tokens(':root {');
    const light = { ...dark, ...tokens(':root[data-theme="light"] {') };
    // The pause ring reads a theme token, so a theme made in chat can set its own gold (docs/maps/ui-themes.md).
    expect(declarations(source, '.chat-job-strip')).toMatchObject({ '--job-pause': 'var(--ring-yellow)', '--job-done': 'var(--green)', '--job-run': 'var(--accent)' });
    expect(css).not.toContain(':root[data-theme="light"] .chat-job-strip');
    expect(dark['ring-yellow']).toBe('var(--yellow)');
    const lightPause = light['ring-yellow'];
    expect(lightPause).toBe('#c28a00');
    const rings: Array<[string, string, string]> = [
      ['dark yellow', dark.yellow, dark.surface],
      ['dark green', dark.green, dark.surface],
      ['light yellow', lightPause, light.surface],
      ['light green', light.green, light.surface],
    ];
    for (const [name, colour, surface] of rings) expect(contrast(colour, surface), name).toBeGreaterThanOrEqual(3);
    // The reason for the override: the theme's own amber is too dark to read as yellow on white (it measures higher, but looks brown).
    expect(contrast(light.yellow, light.surface)).toBeGreaterThan(contrast(lightPause, light.surface));
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
