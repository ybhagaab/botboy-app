import { describe, it, expect } from 'vitest';
import {
  detectAnalyticsConversation,
  detectAnalyticsConversationWithPageHint,
  resolveConversationMode,
} from './analytics-chat-context.js';

/**
 * Owner report 2026-08-27: a message unrelated to analytics, sent while a
 * dashboard page was open (and refreshing), got FORCED into analytics mode —
 * the open route used to send a hard mode. It then sat behind the refresh's
 * serialized MCP calls on "Selecting and reading complete business context
 * files...". The open page is now an advisory hint: the message itself must
 * corroborate before analytics mode engages.
 */
describe('resolveConversationMode', () => {
  const HINT = 'analytics_dashboard';

  it('page hint + unrelated message stays GENERAL (the owner-reported case)', () => {
    for (const message of [
      'did my sharepoint sync finish?',
      'summarize the comments on the HLD document',
      'whats on my plate today',
      'create a task to review this chart',
      'update the task about this chart',
      'add this chart to a document',
      'regarding the document about this selected chart, update its title',
      'in the task about this selected chart, change its title',
    ]) {
      expect(resolveConversationMode({ modeHint: HINT, message })).toEqual({ mode: 'general', via: 'default' });
    }
  });

  it('page hint + on-screen reference engages analytics via the hint', () => {
    for (const message of [
      'why is this number trending down?',
      'refresh it and tell me what changed',
      'add a chart of weekly captures',
      'change this selected widget to an area view',
      'combine these two widgets into an hconcat view',
      'combine both widgets into one view',
      'what did the query return for last month',
    ]) {
      expect(resolveConversationMode({ modeHint: HINT, message })).toEqual({ mode: 'analytics_dashboard', via: 'page-hint' });
    }
  });

  it('software-implementation talk stays general even with the hint and artifact words', () => {
    expect(resolveConversationMode({ modeHint: HINT, message: 'this chart component throws a stack trace in the frontend' }).mode).toBe('general');
  });

  it('explicit mode commands regardless of hint or message', () => {
    expect(resolveConversationMode({ requestedMode: 'analytics_dashboard', message: 'hello' }))
      .toEqual({ mode: 'analytics_dashboard', via: 'explicit' });
    expect(resolveConversationMode({ requestedMode: 'general', modeHint: HINT, message: 'analyze revenue trends' }))
      .toEqual({ mode: 'general', via: 'explicit' });
  });

  it('strict message-only detection still works without any hint', () => {
    expect(resolveConversationMode({ message: 'analyze conversion by week and rank campaigns' }))
      .toEqual({ mode: 'analytics_dashboard', via: 'detected' });
    expect(resolveConversationMode({ message: 'did my sharepoint sync finish?' }).mode).toBe('general');
  });

  it('unknown hint values are ignored, not honored', () => {
    // 'refresh it…' corroborates only via the page-hint path; a bogus hint
    // must not unlock it, so this falls through to strict detection → general.
    expect(resolveConversationMode({ modeHint: 'bogus', message: 'refresh it and tell me what changed' }))
      .toEqual({ mode: 'general', via: 'default' });
  });
});

describe('ordinary work questions stay general (owner report 2026-10-09)', () => {
  it('work nouns need a time grain or trend to count as analytics', () => {
    for (const message of [
      'what are my top 3 attention items today?',
      'summarize my tasks for this week',
      'how many projects do I have',
      'rank my open tasks by urgency',
      'compare these two projects for me',
      'give me a report of what changed in the Fatafat project',
    ]) {
      expect(resolveConversationMode({ message }), message).toEqual({ mode: 'general', via: 'default' });
    }
    for (const message of [
      'how many items landed by month',
      'chart my captures over time',
      'show messages per day for the last month',
    ]) {
      expect(resolveConversationMode({ message }).mode, message).toBe('analytics_dashboard');
    }
  });
});

describe('detectors', () => {
  it('hinted detector is a strict superset of the message-only detector', () => {
    for (const message of [
      'analyze conversion by week',
      'how many items landed by month',
      'build me a dashboard for slack activity',
    ]) {
      expect(detectAnalyticsConversation(message)).toBe(true);
      expect(detectAnalyticsConversationWithPageHint(message)).toBe(true);
    }
  });

  it('deixis needs a determiner + artifact noun — bare generic nouns do not flip', () => {
    expect(detectAnalyticsConversationWithPageHint('the results of the sync look odd')).toBe(false);
    expect(detectAnalyticsConversationWithPageHint('these numbers look odd')).toBe(true);
  });
});
