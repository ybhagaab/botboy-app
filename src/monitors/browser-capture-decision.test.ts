import { describe, expect, it } from 'vitest';
import {
  GROWTH_MIN_CHARS,
  MAX_RECAPTURES,
  THIN_PAGE_CHARS,
  decideDynamicCapture,
  decideStaticCapture,
  isStaticCaptureExhausted,
  mergeFieldSegments,
  simpleHash,
  type StaticProbe,
  type StaticTabState,
} from './browser-capture-decision.js';

const MAX = 3;
const fresh = (): StaticTabState => ({ settleAttempts: 0 });
function probe(prose: number, fields: Array<[string, string | null]> = [['main', 'f1']], extra: Partial<StaticProbe> = {}): StaticProbe {
  return { text: prose ? 'x'.repeat(prose) : '', proseChars: prose, fieldsChars: 0, fieldSegments: fields, ...extra };
}
const decide = (state: StaticTabState, p: StaticProbe, html?: string) => decideStaticCapture({ state, probe: p, html, maxSettleAttempts: MAX });

/** Runs a first emit and returns the state after it. */
function captured(prose = 400, fields: Array<[string, string | null]> = [['main', 'f1']]): StaticTabState {
  const result = decide(fresh(), probe(prose, fields));
  if (result.action !== 'emit') throw new Error('expected an emit');
  return result.next;
}

describe('decideStaticCapture: first sight', () => {
  it('emits a page with real text, trimmed, and remembers it', () => {
    const result = decide(fresh(), { ...probe(400), text: `  ${'x'.repeat(400)}  ` });
    expect(result.action).toBe('emit');
    if (result.action !== 'emit') return;
    expect(result.content).toBe('x'.repeat(400));
    expect(result.next.settleAttempts).toBe(0);
    expect(result.next.lastSegments).toBeUndefined();
    expect(result.next.captured).toMatchObject({ chars: 400, recaptures: 0, fields: 'main=f1', pendingFields: undefined });
  });

  it('a thin page waits, counting each poll, until the attempts are used', () => {
    let state = fresh();
    for (const attempt of [1, 2]) {
      const result = decide(state, probe(8));
      expect(result.action).toBe('settle-wait');
      expect(result.next.settleAttempts).toBe(attempt);
      expect(result.next.lastSegments?.get('main')).toBe('f1');
      state = result.next;
    }
    const last = decide(state, probe(8));
    expect(last.action).toBe('emit');
    if (last.action === 'emit') expect(last.content).toBe('x'.repeat(8));
  });

  it('a mostly-form page counts its fields as content and is not thin', () => {
    const result = decide(fresh(), probe(10, [['main', 'f1']], { fieldsChars: THIN_PAGE_CHARS }));
    expect(result.action).toBe('emit');
  });

  it('a page with no text asks for its HTML only at the last attempt, then uses its text', () => {
    let state = fresh();
    state = decide(state, probe(0)).next;
    state = decide(state, probe(0)).next;
    expect(state.settleAttempts).toBe(2);
    const ask = decide(state, probe(0));
    expect(ask.action).toBe('need-html');
    expect(ask.next.settleAttempts).toBe(3);
    // The same inputs plus the HTML decide it; attempts are not counted twice.
    const done = decide(state, probe(0), '<html><body><h1>Workbook</h1><p>Shell only</p></body></html>');
    expect(done.action).toBe('emit');
    if (done.action !== 'emit') return;
    expect(done.content).toContain('Workbook');
    expect(done.next.captured?.chars).toBe(done.content.length);
    expect(done.next.settleAttempts).toBe(0);
  });

  it('no text and no HTML text is never captured, and the attempt stays counted', () => {
    const state: StaticTabState = { settleAttempts: 2 };
    for (const html of ['', '<html><body><script>x()</script></body></html>']) {
      const result = decide(state, probe(0), html);
      expect(result.action).toBe('skip');
      expect(result.next.settleAttempts).toBe(3);
    }
  });

  it('a tab whose text could not be read never asks for HTML', () => {
    const result = decide({ settleAttempts: 2 }, probe(0, [], { unavailable: true }));
    expect(result.action).toBe('skip');
    expect(result.next.settleAttempts).toBe(3);
  });

  it('is pure: the same inputs give the same decision and leave the input state alone', () => {
    const state = captured();
    const before = JSON.stringify([state.captured, [...state.captured!.segments]]);
    const first = decide(state, probe(400, [['main', 'f2']]));
    const second = decide(state, probe(400, [['main', 'f2']]));
    expect(second).toEqual(first);
    expect(JSON.stringify([state.captured, [...state.captured!.segments]])).toBe(before);
  });
});

describe('decideStaticCapture: a page captured before', () => {
  it('an unchanged page is skipped and its pending change cleared', () => {
    const state = captured();
    const pending = decide(state, probe(400, [['main', 'f2']]));
    expect(pending.action).toBe('skip');
    expect(pending.next.captured?.pendingFields).toBe('main=f2');
    const back = decide(pending.next, probe(400, [['main', 'f1']]));
    expect(back.action).toBe('skip');
    expect(back.next.captured?.pendingFields).toBeUndefined();
  });

  it('a field change is emitted only on the second equal poll (debounce)', () => {
    const state = captured();
    const first = decide(state, probe(400, [['main', 'f2']]));
    expect(first.action).toBe('skip');
    const second = decide(first.next, probe(400, [['main', 'f2']]));
    expect(second.action).toBe('emit');
    if (second.action !== 'emit') return;
    expect(second.next.captured).toMatchObject({ fields: 'main=f2', recaptures: 1, pendingFields: undefined });
  });

  it('a change that moves again restarts the debounce', () => {
    const state = captured();
    const a = decide(state, probe(400, [['main', 'f2']]));
    const b = decide(a.next, probe(400, [['main', 'f3']]));
    expect(b.action).toBe('skip');
    expect(b.next.captured?.pendingFields).toBe('main=f3');
  });

  it('the debounce moves only when a decision is made: deciding twice on the same state is one step', () => {
    // A poll that never reaches the decision (deferred, paused) leaves the state as it was.
    const state = captured();
    const a = decide(state, probe(400, [['main', 'f2']]));
    const again = decide(state, probe(400, [['main', 'f2']]));
    expect(again).toEqual(a);
    expect(again.next.captured?.pendingFields).toBe('main=f2');
  });

  it('growth needs both the ratio and the minimum, and skips the debounce', () => {
    const state = captured(400);
    expect(decide(state, probe(400 * 1.5 - 1)).action).toBe('skip');
    expect(decide(state, probe(400 + GROWTH_MIN_CHARS - 1)).action).toBe('skip');
    const grew = decide(state, probe(400 * 2));
    expect(grew.action).toBe('emit');
    if (grew.action === 'emit') expect(grew.next.captured).toMatchObject({ chars: 800, recaptures: 1 });
    // Growth emits even while a field change is still unconfirmed.
    const pending = decide(state, probe(400, [['main', 'f2']]));
    expect(decide(pending.next, probe(800, [['main', 'f3']])).action).toBe('emit');
  });

  it('field values never count toward growth', () => {
    const state = captured(400);
    const result = decide(state, { ...probe(400), fieldsChars: 5000 });
    expect(result.action).toBe('skip');
  });

  it('an unread segment keeps its previous read; a never-read one is marked unread', () => {
    const state = captured(400, [['main', 'f1'], ['frame:0:https://x.test/', 'g1']]);
    const unchanged = decide(state, probe(400, [['main', 'f1'], ['frame:0:https://x.test/', null]]));
    expect(unchanged.action).toBe('skip');
    expect(unchanged.next.captured?.pendingFields).toBeUndefined();
    expect(unchanged.next.captured?.segments.get('frame:0:https://x.test/')).toBe('g1');
    const firstRead = decide(fresh(), probe(400, [['main', null]]));
    expect(firstRead.action).toBe('emit');
    if (firstRead.action === 'emit') expect(firstRead.next.captured?.fields).toBe('main=main|unread');
  });

  it('a page captured the maximum number of times is exhausted (checked before any read)', () => {
    let state = captured(400);
    expect(isStaticCaptureExhausted(state)).toBe(false);
    let prose = 400;
    for (let i = 0; i < MAX_RECAPTURES; i++) {
      prose *= 2;
      const result = decide(state, probe(prose));
      expect(result.action).toBe('emit');
      state = result.next;
    }
    expect(state.captured?.recaptures).toBe(MAX_RECAPTURES);
    expect(isStaticCaptureExhausted(state)).toBe(true);
    expect(isStaticCaptureExhausted(fresh())).toBe(false);
  });

  it('a thin read of a captured page is not a settle: it is judged by growth and fields alone', () => {
    const result = decide(captured(400), probe(5));
    expect(result.action).toBe('skip');
    expect(result.next.settleAttempts).toBe(0);
  });
});

describe('mergeFieldSegments', () => {
  it('fills unread segments from the previous poll and joins the fingerprint in read order', () => {
    const previous = new Map([['main', 'a'], ['frame:0:u', 'b']]);
    const merged = mergeFieldSegments(previous, [['main', 'a2'], ['frame:0:u', null], ['frame:1:v', null]]);
    expect(merged.fingerprint).toBe('main=a2\nframe:0:u=b\nframe:1:v=frame:1:v|unread');
    expect([...merged.segments.keys()]).toEqual(['main', 'frame:0:u', 'frame:1:v']);
    expect(mergeFieldSegments(undefined, []).fingerprint).toBe('');
  });
});

describe('decideDynamicCapture', () => {
  it('emits on a changed hash only and never on empty text', () => {
    expect(decideDynamicCapture(undefined, '')).toEqual({ action: 'skip' });
    const first = decideDynamicCapture(undefined, 'hello');
    expect(first).toEqual({ action: 'emit', hash: simpleHash('hello') });
    expect(decideDynamicCapture(simpleHash('hello'), 'hello')).toEqual({ action: 'skip' });
    expect(decideDynamicCapture(simpleHash('hello'), 'hello again').action).toBe('emit');
  });
});
