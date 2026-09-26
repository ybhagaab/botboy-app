import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  acquireChatRequestId,
  chatRequestReplayKey,
  completeChatRequestId,
  createChatRequestId,
  mergeChatRequestContexts,
  normalizeChatRequestContext,
  reconcileAnalyticsChatSelection,
  toggleAnalyticsChatSelection,
} from './analytics-chat-scope.js';

const routeScope = {
  kind: 'analytics_dashboard',
  dashboardId: 'dash_scope',
  selectedWidgetIds: ['widget_first', 'widget_second'],
};

describe('analytics chat request scope', () => {
  it('retains only locator-safe ordered dashboard scope', () => {
    expect(normalizeChatRequestContext({ mode: 'analytics_dashboard', routeScope })).toEqual({
      mode: 'analytics_dashboard',
      routeScope,
    });
    expect(normalizeChatRequestContext({
      mode: 'analytics_dashboard',
      routeScope: { ...routeScope, selectedWidgetIds: ['widget_first', 'widget_first'] },
    })).toEqual({ mode: 'analytics_dashboard' });
    expect(normalizeChatRequestContext({
      mode: 'analytics_dashboard',
      routeScope: { ...routeScope, privateTitle: 'must not travel' },
    })).toEqual({ mode: 'analytics_dashboard', routeScope });
  });

  it('merges ambient selection with project context but lets explicit general/create scrub it', () => {
    const ambient = { modeHint: 'analytics_dashboard', routeScope };
    const project = { projectId: 'proj_exact', projectTitle: 'Exact Project' };
    expect(mergeChatRequestContexts(ambient, project, 'About project Exact Project (proj_exact): change this widget')).toEqual({
      ...ambient,
      ...project,
    });
    expect(mergeChatRequestContexts(ambient, project, 'unrelated')).toEqual(ambient);
    expect(mergeChatRequestContexts(ambient, { mode: 'general' }, 'change this widget')).toEqual({ mode: 'general' });
    expect(mergeChatRequestContexts(ambient, { mode: 'analytics_dashboard', intent: 'create' }, 'build a dashboard')).toEqual({
      mode: 'analytics_dashboard',
      intent: 'create',
    });
  });

  it('creates one opaque stable request ID per caller invocation', () => {
    const randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555');
    expect(createChatRequestId({ randomUUID } as any)).toBe('11111111-2222-4333-8444-555555555555');
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });
});

describe('analytics widget selection reducer', () => {
  const available = ['widget_first', 'widget_second', 'widget_third'];

  it('preserves click order, toggles without replacement, and caps at two', () => {
    expect(toggleAnalyticsChatSelection([], 'widget_second', available)).toEqual({
      selectedWidgetIds: ['widget_second'], changed: true,
    });
    expect(toggleAnalyticsChatSelection(['widget_second'], 'widget_first', available)).toEqual({
      selectedWidgetIds: ['widget_second', 'widget_first'], changed: true,
    });
    expect(toggleAnalyticsChatSelection(['widget_second', 'widget_first'], 'widget_third', available)).toEqual({
      selectedWidgetIds: ['widget_second', 'widget_first'], changed: false, reason: 'limit',
    });
    expect(toggleAnalyticsChatSelection(['widget_second', 'widget_first'], 'widget_second', available)).toEqual({
      selectedWidgetIds: ['widget_first'], changed: true,
    });
  });

  it('prunes stale, malformed, duplicate, and over-cap selections on repaint', () => {
    expect(reconcileAnalyticsChatSelection(
      ['widget_first', 'widget_missing', 'widget_first', 'widget_second', 'widget_third'],
      available,
    )).toEqual(['widget_first', 'widget_second']);
    expect(toggleAnalyticsChatSelection(['widget_first'], 'widget_missing', available)).toEqual({
      selectedWidgetIds: ['widget_first'], changed: false, reason: 'stale',
    });
  });
});


describe('analytics widget-selection UI seams', () => {
  it('keeps selection visible, accessible, repaint-safe, route-scoped, and independent of worker progress', () => {
    const dashboard = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
    const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
    const css = readFileSync(new URL('./dashboard.css', import.meta.url), 'utf8');
    expect(dashboard).toContain('chatSelection: new Map()');
    expect(dashboard).toContain('data-action="analytics-chat-select"');
    expect(dashboard).toContain('aria-pressed="${selectedForChat}"');
    expect(dashboard).toContain("selectedWidgetIds: dashboard ? analyticsChatSelection(dashboard) : []");
    expect(dashboard).toContain("if (action === 'analytics-chat-select')");
    expect(dashboard).toContain('focusAnalyticsChatSelector(dashboardId, widgetId)');
    expect(dashboard).not.toContain('selectedWidgetIds: [activeRun?.currentWidgetId]');
    expect(app).toContain('requestId, thinking: chatThinkingLevel()');
    expect(app).toContain('mergeChatRequestContexts(ambientChatRequestContext, chatRequestContext, message)');
    expect(css).toContain('.analytics-chat-select:focus-visible');
    expect(css).toContain('.analytics-widget.is-botboy-selected');
    expect(css).toContain('.analytics-widget-actions{width:100%');
  });
});


describe('chat request lost-response identity', () => {
  function memoryStorage() {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      values,
    };
  }

  it('reuses one pending ID only for the exact message/context/attachments until done', () => {
    const storage = memoryStorage();
    const randomUUID = vi.fn()
      .mockReturnValueOnce('11111111-2222-4333-8444-555555555555')
      .mockReturnValueOnce('66666666-7777-4888-8999-aaaaaaaaaaaa');
    const firstKey = chatRequestReplayKey('Create a view', {
      routeScope: { selectedWidgetIds: ['widget_one'], dashboardId: 'dash_one', kind: 'analytics_dashboard' },
      modeHint: 'analytics_dashboard',
    }, ['att_aaaaaaaaaaaa']);
    const sameKeyDifferentObjectOrder = chatRequestReplayKey('Create a view', {
      modeHint: 'analytics_dashboard',
      routeScope: { kind: 'analytics_dashboard', dashboardId: 'dash_one', selectedWidgetIds: ['widget_one'] },
    }, ['att_aaaaaaaaaaaa']);
    expect(sameKeyDifferentObjectOrder).toBe(firstKey);
    const first = acquireChatRequestId({ storage, replayKey: firstKey, cryptoLike: { randomUUID }, now: 1_000 });
    const retry = acquireChatRequestId({ storage, replayKey: sameKeyDifferentObjectOrder, cryptoLike: { randomUUID }, now: 2_000 });
    expect(retry).toBe(first);
    expect(randomUUID).toHaveBeenCalledTimes(1);
    completeChatRequestId('different-request', storage);
    expect(storage.values.size).toBe(1);
    completeChatRequestId(first, storage);
    expect(storage.values.size).toBe(0);
    const next = acquireChatRequestId({ storage, replayKey: firstKey, cryptoLike: { randomUUID }, now: 3_000 });
    expect(next).not.toBe(first);
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a pending ID for a different context or after its bounded age', () => {
    const storage = memoryStorage();
    const randomUUID = vi.fn()
      .mockReturnValueOnce('11111111-2222-4333-8444-555555555555')
      .mockReturnValueOnce('66666666-7777-4888-8999-aaaaaaaaaaaa')
      .mockReturnValueOnce('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff');
    const firstKey = chatRequestReplayKey('Create a view', { modeHint: 'analytics_dashboard' });
    const changedKey = chatRequestReplayKey('Create a view', { mode: 'general' });
    const formerCollisionA = chatRequestReplayKey('Create a new point chart from this selected widget. Ref 18vwwdi', { modeHint: 'analytics_dashboard' });
    const formerCollisionB = chatRequestReplayKey('Create a new point chart from this selected widget. Ref 0jyr4b3', { modeHint: 'analytics_dashboard' });
    expect(formerCollisionA).not.toBe(formerCollisionB);
    const first = acquireChatRequestId({ storage, replayKey: firstKey, cryptoLike: { randomUUID }, now: 0 });
    const changed = acquireChatRequestId({ storage, replayKey: changedKey, cryptoLike: { randomUUID }, now: 1 });
    expect(changed).not.toBe(first);
    const expired = acquireChatRequestId({
      storage, replayKey: changedKey, cryptoLike: { randomUUID }, now: 24 * 60 * 60_000 + 2,
    });
    expect(expired).not.toBe(changed);
  });
});