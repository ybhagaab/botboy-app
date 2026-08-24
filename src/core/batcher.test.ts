import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { createStorage, StorageLayer } from './storage.js';
import { createBatcher, Batcher, ProcessState, TERMINAL_STATES } from './batcher.js';

describe('Batcher', () => {
  let storage: StorageLayer;
  let batcher: Batcher;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    batcher = createBatcher(storage.getDb(), { waveSize: 3, sizeTrigger: 2, ageTriggerMs: 60000 });
  });
  afterEach(() => storage.close());

  function insert(id: string, state: ProcessState, capturedAt = '2026-07-08T10:00:00Z') {
    storage.getDb().prepare(
      `INSERT INTO work_items (id, type, source, title, captured_at, process_state)
       VALUES (?, 'website_visit', 'browser', ?, ?, ?)`,
    ).run(id, `title-${id}`, capturedAt, state);
  }

  it('selects only extracted + unrouted items, oldest first, up to waveSize', () => {
    insert('a', 'captured');
    insert('b', 'extracted', '2026-07-08T09:00:00Z');
    insert('c', 'extracted', '2026-07-08T08:00:00Z');
    insert('d', 'extracted', '2026-07-08T07:00:00Z');
    insert('e', 'extracted', '2026-07-08T06:00:00Z'); // 4 eligible, waveSize=3

    const wave = batcher.nextWave()!;
    expect(wave.items.map((i) => i.id)).toEqual(['e', 'd', 'c']); // oldest first, 3 of them
    // batch_id stamped
    const row = storage.getDb().prepare('SELECT batch_id FROM work_items WHERE id = ?').get('e') as any;
    expect(row.batch_id).toBe(wave.batchId);
  });

  it('shouldFire respects the size trigger', () => {
    const now = new Date().toISOString(); // fresh → age trigger won't fire
    insert('a', 'extracted', now);
    expect(batcher.shouldFire()).toBe(false); // 1 < sizeTrigger(2), and not aged
    insert('b', 'extracted', now);
    expect(batcher.shouldFire()).toBe(true); // 2 >= 2
  });

  it('shouldFire respects the age trigger for a single old item', () => {
    insert('old', 'extracted', '2020-01-01T00:00:00Z'); // far in the past
    expect(batcher.shouldFire()).toBe(true); // aged past ageTriggerMs
  });

  it('P5: terminal items (routed/noise) are never re-selected', () => {
    insert('a', 'extracted');
    batcher.transition('a', 'routed', { projectId: 'p1' });
    insert('b', 'extracted');
    batcher.transition('b', 'noise');
    insert('c', 'extracted');
    const wave = batcher.nextWave();
    expect(wave!.items.map((i) => i.id)).toEqual(['c']);
  });

  it('P5: disallows regressions and illegal transitions', () => {
    insert('a', 'routed');
    // routed is terminal — nothing allowed
    expect(batcher.transition('a', 'extracted')).toBe(false);
    expect(batcher.transition('a', 'orphaned')).toBe(false);

    insert('b', 'captured');
    expect(batcher.transition('b', 'routed')).toBe(false); // must extract first
    expect(batcher.transition('b', 'extracted')).toBe(true);
    expect(batcher.transition('b', 'routed', { projectId: 'p1' })).toBe(true);
  });

  it('P5 (property): a terminal item is never returned by nextWave regardless of history', () => {
    const arbState = fc.constantFrom<ProcessState>(
      'captured', 'extracted', 'routed', 'orphaned', 'noise', 'extract_failed', 'route_failed',
    );
    fc.assert(
      fc.property(fc.array(arbState, { minLength: 1, maxLength: 12 }), (states) => {
        // fresh table each run
        storage.getDb().prepare('DELETE FROM work_items').run();
        states.forEach((s, i) => insert(`i${i}`, s, `2026-07-08T${String(i % 24).padStart(2, '0')}:00:00Z`));
        const b = createBatcher(storage.getDb(), { waveSize: 50 });
        const wave = b.nextWave();
        const selected = wave ? wave.items.map((x) => x.id) : [];
        for (const id of selected) {
          const row = storage.getDb().prepare('SELECT process_state FROM work_items WHERE id = ?').get(id) as any;
          expect(TERMINAL_STATES.has(row.process_state)).toBe(false);
          expect(row.process_state).toBe('extracted');
        }
      }),
      { numRuns: 100 },
    );
  });
});
