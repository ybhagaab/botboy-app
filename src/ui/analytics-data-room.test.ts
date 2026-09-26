import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  analyticsControlBaseKey,
  buildAnalyticsControlApplyPayload,
  createAnalyticsControlDraft,
  materializeAnalyticsControlValues,
  nextAnalyticsShownSort,
  reconcileAnalyticsControlDraft,
  sortAnalyticsShownRows,
} from './analytics-data-room.js';

function widget(overrides: Record<string, unknown> = {}) {
  return {
    id: 'widget_1',
    revision: 3,
    binding: { revision: 2 },
    controls: {
      controlRevision: 4,
      currentValuesSha256: 'a'.repeat(64),
      definitionSha256: 'b'.repeat(64),
      currentValues: {
        version: 1,
        dateRange: { start: '2026-09-01', end: '2026-09-02' },
        filters: [{ field: 'region', operator: 'eq', value: 'US' }],
        sort: null,
      },
      definition: {
        datasetDefinitionRevision: 5,
        datasetDefinitionSha256: 'c'.repeat(64),
        contractSha256: 'd'.repeat(64),
        filters: [
          { field: 'region', logicalType: 'string', operators: ['eq', 'in'] },
          { field: 'events', logicalType: 'integer', operators: ['eq', 'in', 'gte', 'lte', 'between'] },
        ],
      },
    },
    ...overrides,
  } as any;
}

describe('analytics Data Room control drafts', () => {
  it('builds the complete CAS and preserves dirty values across a canonical repaint', () => {
    const initial = widget();
    const draft = createAnalyticsControlDraft(initial)!;
    expect(analyticsControlBaseKey(initial)).toBe(draft.baseKey);
    draft.dateRange.start = '2026-09-02';
    draft.dirty = true;

    const advanced = widget({
      revision: 4,
      controls: {
        ...initial.controls,
        controlRevision: 5,
        currentValuesSha256: 'e'.repeat(64),
      },
    });
    const reconciled = reconcileAnalyticsControlDraft(draft, advanced)!;
    expect(reconciled.dateRange.start).toBe('2026-09-02');
    expect(reconciled.expected).toMatchObject({ widgetRevision: 4, controlRevision: 5 });
    expect(reconciled).toMatchObject({ dirty: true, conflict: true, definitionChanged: false });
    expect(reconcileAnalyticsControlDraft(createAnalyticsControlDraft(initial), advanced)?.dirty).toBe(false);
  });

  it('blocks a dirty draft when the server definition changed', () => {
    const initial = widget();
    const draft = createAnalyticsControlDraft(initial)!;
    draft.dirty = true;
    const changed = widget({
      controls: { ...initial.controls, definitionSha256: 'f'.repeat(64) },
    });
    const reconciled = reconcileAnalyticsControlDraft(draft, changed)!;
    expect(reconciled.definitionChanged).toBe(true);
    expect(() => buildAnalyticsControlApplyPayload(changed, reconciled)).toThrow(/definition changed/i);
  });

  it('materializes typed filter values and the full server-issued Apply receipt', () => {
    const current = widget();
    const draft = createAnalyticsControlDraft(current)!;
    draft.filters = [
      { field: 'region', operator: 'in', valueText: 'US, IN' },
      { field: 'events', operator: 'between', valueText: '10, 20' },
    ];
    draft.sort = { field: 'events', direction: 'desc' };
    const values = materializeAnalyticsControlValues(draft, current.controls.definition);
    expect(values).toEqual({
      version: 1,
      dateRange: { start: '2026-09-01', end: '2026-09-02' },
      filters: [
        { field: 'region', operator: 'in', value: ['US', 'IN'] },
        { field: 'events', operator: 'between', value: [10, 20] },
      ],
      sort: { field: 'events', direction: 'desc' },
    });
    expect(buildAnalyticsControlApplyPayload(current, draft)).toEqual({
      expected: {
        widgetRevision: 3,
        bindingRevision: 2,
        controlRevision: 4,
        controlValuesSha256: 'a'.repeat(64),
        controlDefinitionSha256: 'b'.repeat(64),
        datasetDefinitionRevision: 5,
        datasetDefinitionSha256: 'c'.repeat(64),
        contractSha256: 'd'.repeat(64),
      },
      controls: values,
    });
  });
});

describe('analytics shown-row sorting', () => {
  it('sorts a copy stably with typed values and nulls while cycling asc/desc/off', () => {
    const rows = [['b', 2], ['a', null], ['a', 1], ['a', 1]];
    const ascending = sortAnalyticsShownRows(rows, 0, 'asc');
    expect(ascending).toEqual([['a', null], ['a', 1], ['a', 1], ['b', 2]]);
    expect(ascending[1]).toBe(rows[2]);
    expect(ascending[2]).toBe(rows[3]);
    expect(rows).toEqual([['b', 2], ['a', null], ['a', 1], ['a', 1]]);
    expect(sortAnalyticsShownRows(rows, 1, 'desc')).toEqual([['b', 2], ['a', 1], ['a', 1], ['a', null]]);
    expect(nextAnalyticsShownSort(null, 1)).toEqual({ columnIndex: 1, direction: 'asc' });
    expect(nextAnalyticsShownSort({ columnIndex: 1, direction: 'asc' }, 1)).toEqual({ columnIndex: 1, direction: 'desc' });
    expect(nextAnalyticsShownSort({ columnIndex: 1, direction: 'desc' }, 1)).toBeNull();
  });
});

describe('analytics Data Room SPA seams', () => {
  it('owns routed catalog caches, one existing poll, exact mutations, and accessible controls', () => {
    const dashboard = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
    const css = readFileSync(new URL('./dashboard.css', import.meta.url), 'utf8');
    const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

    expect(dashboard).toContain("return { view: 'data-room' }");
    expect(dashboard).toContain("return { view: 'data-room-dataset', datasetId: id }");
    expect(dashboard).toContain("{ view: 'data-room-version', versionId: id }");
    expect(dashboard).toContain("['data-room', 'database', 'Data Room', '#/data-room'");
    expect(dashboard).toContain("['Open Data Room'");
    const datasetBranch = dashboard.indexOf('entry.item?.datasetId');
    const artifactBranch = dashboard.indexOf('entry.item?.artifactId', datasetBranch);
    const docKeyBranch = dashboard.indexOf('entry.item?.docKey', datasetBranch);
    expect(datasetBranch).toBeGreaterThan(0);
    expect(datasetBranch).toBeLessThan(artifactBranch);
    expect(artifactBranch).toBeLessThan(docKeyBranch);
    expect(dashboard).toContain("route: `#/data-room/${encodeURIComponent(entry.item.datasetId)}`");
    expect(dashboard.indexOf('if (item.route) return go(item.route)'))
      .toBeLessThan(dashboard.indexOf("if (item.url) return window.open(item.url"));
    expect(dashboard).toContain('dataRoomDetails: new Map()');
    expect(dashboard).toContain('lastDataRoomVersion: null');
    expect(dashboard).toContain('payload.dataRoomVersion');
    expect(dashboard).toContain("setInterval(() => { if (!document.hidden) void pollVersion(); }, 5000)");
    expect(dashboard).not.toContain('setInterval(loadDataRoom');
    expect(dashboard).toContain('data-action="analytics-manage-data"');
    expect(dashboard).toContain('aria-expanded="${manageOpen}"');
    expect(dashboard).toContain('aria-controls="analytics-controls-${attr(widget.id)}"');
    expect(dashboard).toContain("method: 'PUT', body,");
    expect(dashboard).toContain("body: { expectedRevision: widget.binding.revision, binding: null }");
    expect(dashboard).toContain('binding: selected.bindingTemplate');
    expect(dashboard).toContain('data-action="analytics-shown-sort"');
    expect(dashboard).toContain('aria-sort="${activeSort.direction');
    expect(dashboard).toContain('data-scroll-key="analytics:table:${attr(widget.id)}"');
    expect(dashboard).toContain('data-scroll-key="${attr(key)}"');
    expect(dashboard).toContain("error.nextAction = payload?.nextAction || ''");
    expect(dashboard).toContain("const dataRoomViews = ['data-room', 'data-room-dataset', 'data-room-version', 'data-room-imports', 'data-room-import']");
    expect(dashboard).toContain("if (parts[1] === 'imports') return parts[2]");
    expect(dashboard.indexOf("if (parts[1] === 'imports')"))
      .toBeLessThan(dashboard.indexOf("if (parts[1]) return { view: 'data-room-dataset'"));
    expect(dashboard).toContain('dataRoomImportList: null');
    expect(dashboard).toContain("'/analytics/data-room/imports?limit=100'");
    expect(dashboard).toContain("'X-BotBoy-Owner-Requested': 'true'");
    expect(dashboard).toContain('data-action="data-room-import-upload"');
    expect(dashboard).toContain('data-action="data-room-import-inspect"');
    expect(dashboard).toContain("state.route.view === 'data-room-imports'");
    expect(dashboard).toContain("state.route.view === 'data-room-import'");
    expect(css).toContain('.data-room-import-sources');
    expect(css).toContain('.data-room-import-disclosure');
    expect(css).toContain('.data-room-table-wrap');
    expect(css).toContain('@media(max-width:600px)');
    expect(app).not.toContain("view: 'data-room'");
  });
});
