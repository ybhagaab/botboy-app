import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { groupTodayDeferredItems, nextTodayFocusIndex, renderTodayView, todayPaneHandoffDelta } from './today.js';

const esc = (value: unknown) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

function item(id: string, projectId: string, projectTitle: string, title: string) {
  return {
    id,
    kind: 'task',
    projectId,
    projectTitle,
    title,
    reason: 'Explicit open task in the project brain',
    state: 'todo',
    updatedAt: '2026-09-09T05:00:00.000Z',
    freshEvidenceCount: 0,
    pinned: false,
    score: 82,
  };
}

function group(projectId: string, projectTitle: string, rank: number, items: any[]) {
  return {
    projectId,
    projectTitle,
    projectControlId: `project:${projectId}`,
    rank,
    projectPinned: false,
    pinned: false,
    score: 82,
    items,
    hiddenCount: 0,
    counts: { open: items.length, doing: 0, blocked: 0, blockers: 0, decisions: 0, total: items.length },
    freshEvidenceCount: 0,
  };
}

function context() {
  const first = group('p_one', 'Project One', 1, [
    item('task:p_one:111111111111111111', 'p_one', 'Project One', 'Group one top action'),
    item('task:p_one:222222222222222222', 'p_one', 'Project One', 'Group one second action'),
  ]);
  const second = group('p_two', 'Project Two', 2, [
    item('task:p_two:333333333333333333', 'p_two', 'Project Two', 'Group two first action'),
    item('task:p_two:444444444444444444', 'p_two', 'Project Two', 'Group two second action'),
  ]);
  const waitingItem = { ...item('blocker:p_wait:555555555555555555', 'p_wait', 'Waiting Project', 'External approval pending'), kind: 'blocker', state: 'blocked' };
  const waiting = {
    ...group('p_wait', 'Waiting Project', 1, [waitingItem]),
    counts: { open: 0, doing: 0, blocked: 0, blockers: 1, decisions: 0, total: 1 },
  };
  return {
    data: {
      generatedAt: '2026-09-09T05:00:00.000Z',
      since: '2026-09-08T05:00:00.000Z',
      sinceLabel: 'last_visit',
      cursor: { sinceRowId: 1, throughRowId: 2 },
      summary: {
        attentionCount: 4,
        explicitActionCount: 4,
        pinnedProjectCount: 0,
        attentionShown: 4,
        attentionProjects: 2,
        attentionProjectsShown: 2,
        waitingCount: 1,
        waitingShown: 1,
        waitingProjects: 1,
        waitingProjectsShown: 1,
        changeCount: 1,
        changesShown: 1,
        deferredCount: 0,
        deferredShown: 0,
        pinnedCount: 0,
        awaitingReplyCount: 0,
      },
      attention: [...first.items, ...second.items],
      waiting: waiting.items,
      attentionGroups: [first, second],
      waitingGroups: [waiting],
      awaitingReply: [],
      changes: [{
        id: 'change:p_change',
        kind: 'change',
        projectId: 'p_change',
        projectTitle: 'Changed Project',
        projectControlId: 'project:p_change',
        title: 'A source changed',
        summary: 'Document · source',
        reason: '1 substantive evidence item',
        source: 'sharepoint',
        type: 'document_capture',
        capturedAt: '2026-09-09T04:00:00.000Z',
        version: 8,
        count: 1,
        items: [{
          itemId: 'e1', gist: 'A source changed', gistKind: 'derived', meta: 'Document · source',
          kindLabel: 'Document', icon: 'file', actor: 'Owner', actorIsOwner: true,
          source: 'sharepoint', type: 'document_capture', capturedAt: '2026-09-09T04:00:00.000Z', version: 8,
        }],
        hiddenCount: 0,
        pinned: false,
      }],
      recent: [],
      deferred: [],
    },
    error: '',
    pending: new Set(),
    focus: { attention: 'p_two', waiting: 'p_wait', changes: 'p_change' },
    health: { totalFailures: 0, incompleteItems: 0 },
    inbox: { count: 0 },
    pageHead: (_eyebrow: string, title: string) => `<header><h1>${esc(title)}</h1></header>`,
    icon: (name: string) => `<i data-icon="${esc(name)}"></i>`,
    esc,
    attr: esc,
    number: (value: unknown) => String(value ?? 0),
    relativeTime: () => '1 hr ago',
    sourceIcon: () => 'file',
  };
}

describe('Today list-detail focus boards', () => {
  it('supports roving tab focus on both desktop and narrow rail axes', () => {
    expect(nextTodayFocusIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextTodayFocusIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextTodayFocusIndex('ArrowUp', 0, 3)).toBe(2);
    expect(nextTodayFocusIndex('ArrowLeft', 1, 3)).toBe(0);
    expect(nextTodayFocusIndex('Home', 2, 3)).toBe(0);
    expect(nextTodayFocusIndex('End', 0, 3)).toBe(2);
    expect(nextTodayFocusIndex('Enter', 0, 3)).toBeNull();
  });

  it('hands vertical wheel deltas to the page only at pane boundaries', () => {
    const probe = (overrides: Record<string, number>) => todayPaneHandoffDelta({
      scrollTop: 40, scrollHeight: 300, clientHeight: 100, deltaX: 0, deltaY: 24, ...overrides,
    });
    expect(probe({})).toBe(0);
    expect(probe({ scrollTop: 0, deltaY: -20 })).toBe(-20);
    expect(probe({ scrollTop: 200, deltaY: 20 })).toBe(20);
    expect(probe({ scrollTop: 0, scrollHeight: 80, clientHeight: 100, deltaY: 20 })).toBe(20);
    expect(probe({ scrollTop: 200, deltaX: 28, deltaY: 20 })).toBe(0);
    expect(probe({ scrollTop: 200, deltaX: 20, deltaY: 20 })).toBe(0);
  });

  it('renders every project in the rail and every selected group item in detail with composite controls', () => {
    const dom = new JSDOM(renderTodayView(context() as any));
    const document = dom.window.document;
    const attentionRail = document.querySelectorAll('[data-section="attention"] .today-focus-tab');
    expect(attentionRail).toHaveLength(2);
    expect([...attentionRail].map(node => node.getAttribute('data-project'))).toEqual(['p_one', 'p_two']);
    expect(attentionRail[1].getAttribute('aria-selected')).toBe('true');
    expect(attentionRail[1].getAttribute('tabindex')).toBe('0');

    const detail = document.querySelector('#today-attention-detail')!;
    expect(detail.textContent).toContain('Group two first action');
    expect(detail.textContent).toContain('Group two second action');
    expect(detail.textContent).not.toContain('Group one second action');
    expect(detail.querySelector('.today-focus-more')).toBeNull();
    expect(detail.querySelector('[data-action="today-project-snooze"]')?.getAttribute('data-project')).toBe('p_two');
    expect(detail.querySelector('[data-action="today-project-dismiss"]')?.getAttribute('data-section')).toBe('attention');
    expect(detail.querySelector('[data-action="today-pin"]')).not.toBeNull();
    expect(detail.querySelector('[data-action="today-dismiss"][data-item]')).not.toBeNull();
    expect(document.querySelector('#today-changes-detail [data-action^="today-project-"]')).toBeNull();
  });

  it('uses the same explicit three-row header grid for attention, waiting, and meaningful changes', () => {
    const dom = new JSDOM(renderTodayView(context() as any));
    const document = dom.window.document;
    const sections = ['attention', 'waiting', 'changes'];

    for (const section of sections) {
      const head = document.querySelector(`#today-${section}-detail .today-focus-detail-head`)!;
      expect([...head.children].map(child => child.className)).toEqual([
        'today-focus-detail-eyebrow',
        'today-focus-detail-actions',
        'today-focus-detail-title',
        'today-focus-detail-facts',
      ]);
      expect(head.querySelector(':scope > .today-focus-detail-title a')?.textContent).toBeTruthy();
      expect(head.querySelector(':scope > .today-focus-detail-actions')).not.toBeNull();
    }

    expect(document.querySelector('#today-attention-detail .today-focus-detail-eyebrow')?.textContent).toBe('Priority 02');
    expect(document.querySelector('#today-waiting-detail .today-focus-detail-eyebrow')?.textContent).toBe('Waiting 01');
    expect(document.querySelector('#today-changes-detail .today-focus-detail-eyebrow')?.textContent).toBe('1 new · latest 1 hr ago');
    expect(document.querySelector('.today-focus-detail-copy')).toBeNull();
  });

  it('keeps project and item pins visible in the rail and selected detail', () => {
    const model = context() as any;
    const [containsPinnedItem, selectedPinnedProject] = model.data.attentionGroups;
    containsPinnedItem.items[0].pinned = true;
    containsPinnedItem.pinned = true;
    selectedPinnedProject.items[0].pinned = true;
    selectedPinnedProject.projectPinned = true;
    selectedPinnedProject.pinned = true;
    const dom = new JSDOM(renderTodayView(model));
    const document = dom.window.document;

    const itemPinnedTab = document.querySelector('[data-section="attention"] [data-project="p_one"]')!;
    expect(itemPinnedTab.classList.contains('has-pin')).toBe(true);
    expect(itemPinnedTab.textContent).toContain('Pinned item');
    const selectedTab = document.querySelector('[data-section="attention"] [data-project="p_two"]')!;
    expect(selectedTab.classList.contains('selected')).toBe(true);
    expect(selectedTab.classList.contains('has-pin')).toBe(true);
    expect(selectedTab.textContent).toContain('Project pinned');

    const detail = document.querySelector('#today-attention-detail')!;
    const projectPin = detail.querySelector('.today-project-pin.active')!;
    expect(projectPin.textContent).toContain('Project pinned');
    const pinnedLine = detail.querySelector('.today-focus-line.pinned')!;
    expect(pinnedLine.querySelector('.today-focus-line-pinned')?.textContent).toContain('Pinned');
    expect(pinnedLine.querySelector('[data-icon="pin"]')).not.toBeNull();
  });

  it('groups Set aside by project, stays compact by default, and preserves item plus project restore controls', () => {
    const model = context() as any;
    model.data.deferred = [
      {
        ...item('task:p_one:aaaaaaaaaaaaaaaaaa', 'p_one', 'Project One', 'Snoozed recovery task'),
        deferredReason: 'Snoozed until 2026-09-10T09:00:00.000Z',
        snoozedUntil: '2026-09-10T09:00:00.000Z',
        preferenceUpdatedAt: '2026-09-09T04:00:00.000Z',
        pinned: true,
      },
      {
        id: 'change:p_one', kind: 'change', projectId: 'p_one', projectTitle: 'Project One',
        title: 'Dismissed project change', reason: 'Changed', deferredReason: 'Dismissed',
        dismissedAt: '2026-09-09T04:30:00.000Z', preferenceUpdatedAt: '2026-09-09T04:30:00.000Z',
        pinned: false, version: 9,
      },
      {
        ...item('task:p_two:bbbbbbbbbbbbbbbbbb', 'p_two', 'Project Two', 'Collapsed project task'),
        deferredReason: 'Dismissed', dismissedAt: '2026-09-09T03:00:00.000Z',
        preferenceUpdatedAt: '2026-09-09T03:00:00.000Z', pinned: false,
      },
    ];
    model.data.summary.deferredCount = 3;
    model.data.summary.deferredShown = 3;
    model.deferredProject = 'p_one';

    const groups = groupTodayDeferredItems(model.data.deferred);
    expect(groups.map(group => [group.projectId, group.count, group.snoozedCount, group.dismissedCount])).toEqual([
      ['p_one', 2, 1, 1],
      ['p_two', 1, 0, 1],
    ]);
    const dom = new JSDOM(renderTodayView(model));
    const document = dom.window.document;
    const summaries = document.querySelectorAll('.today-deferred-summary');
    expect(summaries).toHaveLength(2);
    expect(summaries[0].getAttribute('aria-expanded')).toBe('true');
    expect(summaries[0].textContent).toContain('1 snoozed · 1 dismissed');
    expect(summaries[1].getAttribute('aria-expanded')).toBe('false');
    expect(document.body.textContent).not.toContain('Collapsed project task');
    expect(document.querySelectorAll('.today-deferred-body .deferred-row')).toHaveLength(2);
    expect(document.querySelectorAll('[data-action="today-restore"]')).toHaveLength(2);
    expect(document.querySelector('[data-action="today-restore"][data-item="change:p_one"]')?.getAttribute('data-version')).toBe('9');
    const projectRestore = document.querySelector('[data-action="today-project-restore"]')!;
    expect(projectRestore.getAttribute('data-section')).toBe('deferred');
    expect(projectRestore.getAttribute('data-project')).toBe('p_one');
  });

  it('auto-sizes both desktop panes to content up to a viewport cap and keeps the narrow rail horizontal', () => {
    const css = readFileSync(new URL('./dashboard.css', import.meta.url), 'utf8');
    expect(css).toContain('--today-focus-max-height:clamp(304px,56dvh,560px)');
    expect(css).toMatch(/\.today-focus-board \{[^}]*height:auto; max-height:var\(--today-focus-max-height\)/);
    expect(css).toMatch(/\.today-focus-rail \{[^}]*max-height:var\(--today-focus-max-height\)[^}]*overflow-y:auto/);
    expect(css).toMatch(/\.today-focus-detail \{[^}]*container:today-focus-detail \/ inline-size[^}]*max-height:var\(--today-focus-max-height\)[^}]*overflow-y:auto/);
    expect(css).not.toMatch(/\.today-focus-(?:rail|detail) \{[^}]*overscroll-behavior:contain/);
    expect(css).toMatch(/\.today-focus-detail-head \{[^}]*display:grid[^}]*grid-template-areas:"eyebrow actions" "title title" "facts facts"/);
    expect(css).toMatch(/\.today-focus-detail-title \{[^}]*grid-area:title[^}]*width:100%/);
    expect(css).toMatch(/\.today-focus-detail-facts \{[^}]*grid-area:facts[^}]*width:100%/);
    expect(css).toMatch(/\.today-focus-detail-actions \{[^}]*grid-area:actions[^}]*flex-wrap:wrap[^}]*max-width:100%/);
    expect(css).toMatch(/@container today-focus-detail \(max-width:520px\)[\s\S]*?grid-template-areas:"eyebrow" "actions" "title" "facts"/);
    expect(css).not.toContain('.today-focus-detail-copy');
    expect(css).toMatch(/@media\(max-width:900px\)[\s\S]*?\.today-focus-board \{[^}]*max-height:none[^}]*overflow:visible/);
    expect(css).toMatch(/@media\(max-width:900px\)[\s\S]*?\.today-focus-rail \{[^}]*max-height:none[^}]*overflow-x:auto; overflow-y:hidden/);
    expect(css).toMatch(/@media\(max-width:900px\)[\s\S]*?\.today-focus-detail \{[^}]*max-height:none[^}]*overflow-y:visible/);
  });
});
