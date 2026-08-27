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
    ]) {
      expect(resolveConversationMode({ modeHint: HINT, message })).toEqual({ mode: 'general', via: 'default' });
    }
  });

  it('page hint + on-screen reference engages analytics via the hint', () => {
    for (const message of [
      'why is this number trending down?',
      'refresh it and tell me what changed',
      'add a chart of weekly captures',
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
    // 'add a chart…' corroborates only via the page-hint path; a bogus hint
    // must not unlock it, so this falls through to strict detection → general.
    expect(resolveConversationMode({ modeHint: 'bogus', message: 'add a chart of weekly captures' }))
      .toEqual({ mode: 'general', via: 'default' });
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
