// @vitest-environment jsdom
//
// Settings → AI model → Chat panel → Show model thinking (dashboard.js), and the thinking block's text in the chat
// panel (app.js). Rendered from the shipped source against a small state object, like ai-model-thinking-ui.test.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const dashboard = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.js'), 'utf8');
const app = readFileSync(path.join(process.cwd(), 'src/ui/app.js'), 'utf8');

function topLevel(source: string, name: string): string {
  const start = source.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 2);
}
function constLine(source: string, name: string): string {
  const match = source.match(new RegExp(`\\nconst ${name} = .*\\n`));
  expect(match, `missing const ${name}`).not.toBeNull();
  return match![0];
}

interface Harness {
  card(status: unknown): string;
  save(): Promise<void>;
  restoreFocus(): void;
  help: string;
}

function loadDashboard(state: Record<string, any>, deps: { request: (...args: any[]) => Promise<any>; toast: (...args: any[]) => void; renderRoute: (...args: any[]) => void }): Harness {
  const source = [
    constLine(dashboard, 'icon'), constLine(dashboard, 'esc'), constLine(dashboard, 'attr'),
    constLine(dashboard, 'AI_MODEL_SHOW_THINKING_HELP'),
    topLevel(dashboard, 'aiModelErrorText'), topLevel(dashboard, 'aiModelChatCard'),
    topLevel(dashboard, 'saveAiModelShowThinking'), topLevel(dashboard, 'restoreAiModelRoleFocus'),
    'return { card: aiModelChatCard, save: saveAiModelShowThinking, restoreFocus: restoreAiModelRoleFocus, help: AI_MODEL_SHOW_THINKING_HELP };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('state', 'request', 'toast', 'renderRoute', source)(state, deps.request, deps.toast, deps.renderRoute) as Harness;
}

const freshState = (chat: unknown) => ({
  route: { view: 'ai-model-settings' },
  aiModel: { status: { state: 'ready', chat }, error: '', loading: false, requestId: 4, roleBusy: '', saving: false, removing: false, pendingFocus: null, chatBusy: false, chatError: '' },
});
const noop = { request: async () => ({}), toast: () => undefined, renderRoute: () => undefined };

describe('Settings → AI model → Show model thinking', () => {
  it('renders one labelled switch that reflects the stored choice, with its help text', () => {
    const on = loadDashboard(freshState({ showThinking: true, updatedAt: null }), noop);
    document.body.innerHTML = on.card({ chat: { showThinking: true, updatedAt: null } });
    const toggle = document.querySelector('[data-action="ai-model-thinking-toggle"]') as HTMLButtonElement;
    expect(document.querySelector('.card-title')!.textContent).toBe('Chat panel');
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.classList.contains('on')).toBe(true);
    expect(toggle.disabled).toBe(false);
    expect(document.getElementById(toggle.getAttribute('aria-labelledby')!)!.textContent).toBe('Show model thinking');
    expect(document.getElementById(toggle.getAttribute('aria-describedby')!)!.textContent).toBe(on.help);
    expect(on.help).toMatch(/Thinking is Low or higher/);
    expect(on.help).toMatch(/verified organizations/);

    document.body.innerHTML = on.card({ chat: { showThinking: false, updatedAt: '2026-10-19T08:00:00.000Z' } });
    const off = document.querySelector('[data-action="ai-model-thinking-toggle"]')!;
    expect(off.getAttribute('aria-checked')).toBe('false');
    expect(off.classList.contains('on')).toBe(false);
  });

  it('renders nothing without a choice from the server, however odd the value', () => {
    const harness = loadDashboard(freshState(undefined), noop);
    for (const chat of [undefined, null, {}, { showThinking: 'true' }, { showThinking: 1 }]) {
      expect(harness.card({ chat }), JSON.stringify(chat)).toBe('');
    }
    expect(harness.card(undefined)).toBe('');
  });

  it('is disabled while saving and shows a failure as an alert', () => {
    const state = freshState({ showThinking: true, updatedAt: null });
    const harness = loadDashboard(state, noop);
    state.aiModel.chatBusy = true;
    state.aiModel.chatError = 'Could not change it: offline <b>';
    document.body.innerHTML = harness.card(state.aiModel.status);
    expect((document.querySelector('[data-action="ai-model-thinking-toggle"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Could not change it: offline <b>');
    expect(document.querySelector('[role="alert"] b')).toBeNull();
  });

  it('flips the stored choice through the owner route, repaints from the answer, and returns focus to the switch', async () => {
    const state = freshState({ showThinking: true, updatedAt: null });
    const next = { state: 'ready', chat: { showThinking: false, updatedAt: '2026-10-19T08:00:00.000Z' } };
    const request = vi.fn(async () => next);
    const toast = vi.fn();
    const renderRoute = vi.fn(() => {
      document.body.innerHTML = harness.card(state.aiModel.status);
    });
    const harness = loadDashboard(state, { request, toast, renderRoute });
    await harness.save();
    expect(request).toHaveBeenCalledWith('/settings/ai-model/chat', { method: 'PUT', body: { showThinking: false } });
    expect(state.aiModel.status).toBe(next);
    expect(state.aiModel.requestId).toBe(5);
    expect(state.aiModel.chatBusy).toBe(false);
    expect(toast).toHaveBeenCalledWith('Chat hides model thinking from your next message.');
    expect(renderRoute).toHaveBeenCalledTimes(2);
    expect(state.aiModel.pendingFocus).toEqual({ thinkingToggle: true });
    harness.restoreFocus();
    expect(document.activeElement?.getAttribute('data-action')).toBe('ai-model-thinking-toggle');
    expect(state.aiModel.pendingFocus).toBeNull();
  });

  it('keeps the choice and says why when saving fails, and ignores clicks while one is in flight', async () => {
    const state = freshState({ showThinking: false, updatedAt: null });
    const request = vi.fn(async () => { throw Object.assign(new Error('x'), { payload: { error: 'AI model settings are unavailable.' } }); });
    const harness = loadDashboard(state, { request, toast: vi.fn(), renderRoute: vi.fn() });
    await harness.save();
    expect(request).toHaveBeenCalledWith('/settings/ai-model/chat', { method: 'PUT', body: { showThinking: true } });
    expect(state.aiModel.status.chat.showThinking).toBe(false);
    expect(state.aiModel.chatError).toBe('Could not change it: AI model settings are unavailable.');
    state.aiModel.chatBusy = true;
    await harness.save();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('is part of the AI model page whenever a model is set up', () => {
    const render = topLevel(dashboard, 'renderAiModelSettings');
    expect(render).toContain("const chatCard = notSetUp ? '' : aiModelChatCard(status);");
    expect(render).toContain('</article>${chatCard}${teamCard}');
    expect(dashboard).toContain("if (action === 'ai-model-thinking-toggle') void saveAiModelShowThinking();");
  });
});

describe('the chat panel thinking block text', () => {
  const load = () => {
    const source = [topLevel(app, 'escHtml'), topLevel(app, 'thinkingTextHtml'), 'return thinkingTextHtml;'].join('\n');
    // eslint-disable-next-line no-new-func
    return new Function(source)() as (text: unknown) => string;
  };

  it('shows each summary heading bold, keeps paragraphs, and stays escaped text', () => {
    const html = load();
    expect(html('**Calculating the product**\n\nI’m multiplying 17 by 23.')).toBe('<strong>Calculating the product</strong><br><br>I’m multiplying 17 by 23.');
    expect(html('**Plan**\n\nA.\n\n**Check**\n\nB.')).toBe('<strong>Plan</strong><br><br>A.<br><br><strong>Check</strong><br><br>B.');
    expect(html('<script>alert(1)</script> **<img src=x onerror=alert(1)>**')).toBe('&lt;script&gt;alert(1)&lt;/script&gt; <strong>&lt;img src=x onerror=alert(1)&gt;</strong>');
    // Never across a line break, never an unmatched pair, and plain DeepSeek text is unchanged.
    expect(html('**a\nb**')).toBe('**a<br>b**');
    expect(html('2 ** 3 is 8')).toBe('2 ** 3 is 8');
    expect(html('First, check x. Then y.')).toBe('First, check x. Then y.');
    expect(html('')).toBe('');
    expect(html(undefined)).toBe('');
  });

  it('is what both the live stream and a finished message render', () => {
    expect(app).toContain('<div class="thinking-content">${thinkingTextHtml(seg.content)}</div>');
    expect(app).toContain('<div class="thinking-content">${thinkingTextHtml(reasoning)}</div>');
  });
});
