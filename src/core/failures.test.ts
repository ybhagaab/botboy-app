import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorage, StorageLayer } from './storage.js';
import { createFailureRecorder, FailureRecorder } from './failures.js';

describe('FailureRecorder', () => {
  let storage: StorageLayer;
  let failures: FailureRecorder;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    failures = createFailureRecorder(storage.getDb());
  });

  afterEach(() => storage.close());

  function insertItem(id: string) {
    storage.getDb().prepare(
      "INSERT INTO work_items (id, type, source, captured_at) VALUES (?, 'website_visit', 'browser', '2026-07-08T10:00:00Z')",
    ).run(id);
  }

  it('records a failure row with step, message and retryable flag', () => {
    failures.record({ itemId: 'w1', step: 'ocr', message: 'no text detected', retryable: true });
    const row = storage.getDb().prepare('SELECT * FROM failures').get() as any;
    expect(row.item_id).toBe('w1');
    expect(row.step).toBe('ocr');
    expect(row.message).toBe('no text detected');
    expect(row.retryable).toBe(1);
  });

  it('marks the work item incomplete when asked', () => {
    insertItem('w1');
    failures.record({ itemId: 'w1', step: 'parse', message: 'partial', markIncomplete: true });
    const row = storage.getDb().prepare('SELECT incomplete FROM work_items WHERE id = ?').get('w1') as any;
    expect(row.incomplete).toBe(1);
  });

  it('aggregates health counts by step, retryable, and incomplete items', () => {
    insertItem('w1');
    insertItem('w2');
    failures.record({ itemId: 'w1', step: 'ocr', message: 'a', retryable: true, markIncomplete: true });
    failures.record({ itemId: 'w1', step: 'ocr', message: 'b', retryable: false });
    failures.record({ itemId: 'w2', step: 'route', message: 'c' }); // default retryable

    const h = failures.health();
    expect(h.totalFailures).toBe(3);
    expect(h.failuresByStep.ocr).toBe(2);
    expect(h.failuresByStep.route).toBe(1);
    expect(h.retryableFailures).toBe(2); // one ocr + one route (default true)
    expect(h.incompleteItems).toBe(1); // only w1 flagged
  });

  it('never throws from record even on a bad step (meta-failure is logged)', () => {
    // 'bogus' violates the CHECK constraint; record() must swallow + log, not throw.
    expect(() =>
      failures.record({ itemId: 'w1', step: 'bogus' as any, message: 'x' }),
    ).not.toThrow();
  });
});
