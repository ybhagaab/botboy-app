import { describe, it, expect } from 'vitest';
import { createDeduplicator } from './deduplicator.js';
import type { RawWorkItem } from './types.js';

function makeSlackItem(overrides: Partial<RawWorkItem> = {}): RawWorkItem {
  return {
    type: 'slack_message',
    source: 'browser',
    sourceApp: 'Chrome',
    content: 'hello team',
    metadata: { channelOrDm: 'general', recipientOrSender: 'alice', direction: 'sent', platform: 'browser' },
    capturedAt: new Date('2026-03-20T10:00:00Z'),
    ...overrides,
  };
}

describe('Deduplicator', () => {
  it('detects duplicate Slack messages within 60s window', () => {
    const dedup = createDeduplicator();
    const item1 = makeSlackItem({ source: 'browser' });
    const item2 = makeSlackItem({ source: 'app', capturedAt: new Date('2026-03-20T10:00:30Z') });

    dedup.register(item1);
    expect(dedup.isDuplicate(item2)).toBe(true);
  });

  it('does not flag Slack messages outside 60s window as duplicates', () => {
    const dedup = createDeduplicator();
    const item1 = makeSlackItem();
    const item2 = makeSlackItem({ capturedAt: new Date('2026-03-20T10:02:00Z') }); // 2 min later

    dedup.register(item1);
    expect(dedup.isDuplicate(item2)).toBe(false);
  });

  it('does not dedup non-Slack items', () => {
    const dedup = createDeduplicator();
    const item1: RawWorkItem = {
      type: 'website_visit', source: 'browser', sourceApp: 'Chrome',
      content: 'same content', metadata: {}, capturedAt: new Date('2026-03-20T10:00:00Z'),
    };
    const item2 = { ...item1 };

    dedup.register(item1);
    expect(dedup.isDuplicate(item2)).toBe(false);
  });

  it('different channels are not duplicates', () => {
    const dedup = createDeduplicator();
    const item1 = makeSlackItem({ metadata: { channelOrDm: 'general', recipientOrSender: 'a', direction: 'sent', platform: 'browser' } });
    const item2 = makeSlackItem({ metadata: { channelOrDm: 'random', recipientOrSender: 'a', direction: 'sent', platform: 'browser' } });

    dedup.register(item1);
    expect(dedup.isDuplicate(item2)).toBe(false);
  });

  it('different content is not a duplicate', () => {
    const dedup = createDeduplicator();
    const item1 = makeSlackItem({ content: 'hello' });
    const item2 = makeSlackItem({ content: 'goodbye' });

    dedup.register(item1);
    expect(dedup.isDuplicate(item2)).toBe(false);
  });
});
