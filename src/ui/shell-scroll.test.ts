import { describe, expect, it, vi } from 'vitest';
import {
  beginRouteNavigation,
  enforceRootScrollOrigin,
  parseReloadScrollSnapshot,
  shouldPreserveOuterScroll,
  startOuterScrollRestore,
} from './shell-scroll.js';

describe('outer shell scroll ownership', () => {
  it('parses route-scoped snapshots and one-cycle legacy scalar stashes', () => {
    expect(parseReloadScrollSnapshot('{"hash":"#/documents","top":42}', '#/today'))
      .toEqual({ hash: '#/documents', top: 42 });
    expect(parseReloadScrollSnapshot('{"hash":"","top":24}', ''))
      .toEqual({ hash: '', top: 24 });
    expect(parseReloadScrollSnapshot('37', '#/today'))
      .toEqual({ hash: '#/today', top: 37 });
    expect(parseReloadScrollSnapshot('broken', '#/today')).toBeNull();
    expect(parseReloadScrollSnapshot('{"hash":"#/today","top":0}', '#/today')).toBeNull();
  });

  it('claims true navigation immediately by cancelling stale restore and resetting outer top', () => {
    const cancel = vi.fn();
    const workspace = { scrollTop: 47 };
    expect(beginRouteNavigation({
      routeChanged: true,
      navigationEpoch: 8,
      workspace,
      cancelPendingRestore: cancel,
    })).toBe(9);
    expect(cancel).toHaveBeenCalledOnce();
    expect(workspace.scrollTop).toBe(0);

    workspace.scrollTop = 31;
    expect(beginRouteNavigation({
      routeChanged: false,
      navigationEpoch: 9,
      workspace,
      cancelPendingRestore: cancel,
    })).toBe(9);
    expect(workspace.scrollTop).toBe(31);
  });

  it('preserves only same-route background/explicit/overlay renders', () => {
    expect(shouldPreserveOuterScroll({ routeChanged: false, preserveScroll: false, overlayOpen: false, userAction: false })).toBe(true);
    expect(shouldPreserveOuterScroll({ routeChanged: false, preserveScroll: true, overlayOpen: false, userAction: true })).toBe(true);
    expect(shouldPreserveOuterScroll({ routeChanged: false, preserveScroll: false, overlayOpen: true, userAction: true })).toBe(true);
    expect(shouldPreserveOuterScroll({ routeChanged: true, preserveScroll: true, overlayOpen: true, userAction: false })).toBe(false);
  });

  it('restores after delayed height becomes reachable', () => {
    const scheduled: Array<() => void> = [];
    const finishes: string[] = [];
    const scroller = { scrollTop: 0, scrollHeight: 120, clientHeight: 100 };
    startOuterScrollRestore({
      snapshot: { hash: '#/documents', top: 80 },
      navigationEpoch: 3,
      getNavigationEpoch: () => 3,
      getHash: () => '#/documents',
      getScroller: () => scroller,
      schedule: callback => { scheduled.push(callback); return 0 as any; },
      now: () => 100,
      onFinish: reason => finishes.push(reason),
    });
    expect(scroller.scrollTop).toBe(0);
    expect(scheduled).toHaveLength(1);
    scroller.scrollHeight = 240;
    scheduled.shift()!();
    expect(scroller.scrollTop).toBe(80);
    expect(finishes).toEqual(['restored']);
  });

  it('cancels a pending restore on route change even after away-and-back to the same hash', () => {
    const scheduled: Array<() => void> = [];
    const finishes: string[] = [];
    let epoch = 4;
    let hash = '#/documents';
    const scroller = { scrollTop: 0, scrollHeight: 100, clientHeight: 100 };
    startOuterScrollRestore({
      snapshot: { hash: '#/documents', top: 40 },
      navigationEpoch: epoch,
      getNavigationEpoch: () => epoch,
      getHash: () => hash,
      getScroller: () => scroller,
      schedule: callback => { scheduled.push(callback); return 0 as any; },
      now: () => 100,
      onFinish: reason => finishes.push(reason),
    });
    hash = '#/today';
    epoch++;
    hash = '#/documents';
    scheduled.shift()!();
    expect(scroller.scrollTop).toBe(0);
    expect(finishes).toEqual(['route-changed']);
  });

  it('yields when the owner moved before delayed restoration', () => {
    const finishes: string[] = [];
    const scroller = { scrollTop: 12, scrollHeight: 300, clientHeight: 100 };
    startOuterScrollRestore({
      snapshot: { hash: '#/today', top: 80 },
      navigationEpoch: 1,
      getNavigationEpoch: () => 1,
      getHash: () => '#/today',
      getScroller: () => scroller,
      onFinish: reason => finishes.push(reason),
    });
    expect(scroller.scrollTop).toBe(12);
    expect(finishes).toEqual(['owner-moved']);
  });

  it('cancellation is idempotent and prevents a queued callback from writing', () => {
    const scheduled: Array<() => void> = [];
    const finish = vi.fn();
    const scroller = { scrollTop: 0, scrollHeight: 100, clientHeight: 100 };
    const cancel = startOuterScrollRestore({
      snapshot: { hash: '#/documents', top: 50 },
      navigationEpoch: 2,
      getNavigationEpoch: () => 2,
      getHash: () => '#/documents',
      getScroller: () => scroller,
      schedule: callback => { scheduled.push(callback); return 0 as any; },
      now: () => 100,
      onFinish: finish,
    });
    cancel();
    cancel();
    scroller.scrollHeight = 300;
    scheduled.shift()!();
    expect(scroller.scrollTop).toBe(0);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith('cancelled');
  });

  it('lets document Expand preserve the same route but makes Back cancel the delayed outer writer', () => {
    const scheduled: Array<() => void> = [];
    const finishes: string[] = [];
    let epoch = 6;
    let hash = '#/documents/artifact-1';
    const workspace = { scrollTop: 0, scrollHeight: 100, clientHeight: 100 };
    const cancel = startOuterScrollRestore({
      snapshot: { hash, top: 70 },
      navigationEpoch: epoch,
      getNavigationEpoch: () => epoch,
      getHash: () => hash,
      getScroller: () => workspace,
      schedule: callback => { scheduled.push(callback); return 0 as any; },
      now: () => 100,
      onFinish: reason => finishes.push(reason),
    });

    epoch = beginRouteNavigation({
      routeChanged: false,
      navigationEpoch: epoch,
      workspace,
      cancelPendingRestore: cancel,
    });
    expect(shouldPreserveOuterScroll({
      routeChanged: false,
      preserveScroll: true,
      overlayOpen: false,
      userAction: true,
    })).toBe(true);
    expect(epoch).toBe(6);
    expect(finishes).toEqual([]);

    workspace.scrollTop = 23;
    hash = '#/documents';
    epoch = beginRouteNavigation({
      routeChanged: true,
      navigationEpoch: epoch,
      workspace,
      cancelPendingRestore: cancel,
    });
    expect(epoch).toBe(7);
    expect(workspace.scrollTop).toBe(0);
    expect(finishes).toEqual(['cancelled']);

    workspace.scrollHeight = 300;
    scheduled.shift()!();
    expect(workspace.scrollTop).toBe(0);
  });

  it('installs reload-scroll ownership before asynchronous core hydration starts', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
    const loadCoreStart = source.indexOf('async function loadCore');
    const loadCoreEnd = source.indexOf('\nasync function openTodayVisit', loadCoreStart);
    const initializeStart = source.indexOf('function initialize()');
    const initializeEnd = source.indexOf('\nwindow.BotBoyDashboard', initializeStart);
    const loadCore = source.slice(loadCoreStart, loadCoreEnd);
    const initialize = source.slice(initializeStart, initializeEnd);
    const stashRead = initialize.indexOf("sessionStorage.getItem('botboy-reload-scroll')");
    const restoreInstall = initialize.indexOf('startOuterScrollRestore({');
    const coreHydration = initialize.indexOf('void loadCore();');

    expect(loadCoreStart).toBeGreaterThanOrEqual(0);
    expect(loadCoreEnd).toBeGreaterThan(loadCoreStart);
    expect(initializeStart).toBeGreaterThanOrEqual(0);
    expect(initializeEnd).toBeGreaterThan(initializeStart);
    expect(loadCore).not.toContain('botboy-reload-scroll');
    expect(stashRead).toBeGreaterThanOrEqual(0);
    expect(restoreInstall).toBeGreaterThan(stashRead);
    expect(coreHydration).toBeGreaterThan(restoreInstall);
  });

  it('resets browser root scroll without touching routed or nested scrollers', () => {
    const scrollingElement = { scrollTop: 64, scrollLeft: 5 };
    const scrollWindow = { scrollY: 64, scrollX: 5, scrollTo: vi.fn() };
    expect(enforceRootScrollOrigin({ scrollingElement, scrollWindow })).toBe(true);
    expect(scrollingElement).toEqual({ scrollTop: 0, scrollLeft: 0 });
    expect(scrollWindow.scrollTo).toHaveBeenCalledOnce();
    expect(scrollWindow.scrollTo).toHaveBeenCalledWith(0, 0);

    const cleanRoot = { scrollTop: 0, scrollLeft: 0 };
    const cleanWindow = { scrollY: 0, scrollX: 0, scrollTo: vi.fn() };
    expect(enforceRootScrollOrigin({ scrollingElement: cleanRoot, scrollWindow: cleanWindow })).toBe(false);
    expect(cleanWindow.scrollTo).not.toHaveBeenCalled();
  });

  it('hardens root-scroll ownership in CSS, history, render, and late browser events', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
    const css = readFileSync(new URL('./dashboard.css', import.meta.url), 'utf8');
    const renderStart = source.indexOf('function renderRoute({ preserveScroll');
    const workspaceRead = source.indexOf("document.getElementById('workspace')", renderStart);
    const rootReset = source.indexOf('enforceShellRootScroll();', renderStart);

    expect(css).toMatch(/html \{ overflow:hidden; \}/);
    expect(source).toContain("history.scrollRestoration = 'manual'");
    expect(source).toContain("window.addEventListener('scroll', enforceShellRootScroll");
    expect(source).toContain("window.addEventListener('pageshow', enforceShellRootScroll");
    expect(source).toContain('requestAnimationFrame(enforceShellRootScroll)');
    expect(rootReset).toBeGreaterThan(renderStart);
    expect(rootReset).toBeLessThan(workspaceRead);
  });
});
