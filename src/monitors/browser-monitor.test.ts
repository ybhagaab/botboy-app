import { describe, it, expect } from 'vitest';
import { detectPlatform } from './browser-monitor.js';

describe('detectPlatform', () => {
  it('detects YouTube videos', () => {
    const result = detectPlatform('https://www.youtube.com/watch?v=abc123', 'Cool Video');
    expect(result.type).toBe('youtube_video');
    expect(result.metadata.videoTitle).toBe('Cool Video');
  });

  it('detects Slack in browser', () => {
    const result = detectPlatform('https://app.slack.com/client/T123/C456', 'general');
    expect(result.type).toBe('slack_message');
    expect(result.metadata.platform).toBe('browser');
  });

  it('detects WhatsApp Web', () => {
    const result = detectPlatform('https://web.whatsapp.com/', 'WhatsApp');
    expect(result.type).toBe('whatsapp_message');
  });

  it('detects Gmail', () => {
    const result = detectPlatform('https://mail.google.com/mail/u/0/#inbox', 'Inbox');
    expect(result.type).toBe('email_read');
  });

  it('detects Outlook', () => {
    const result = detectPlatform('https://outlook.office.com/mail/inbox', 'Inbox');
    expect(result.type).toBe('email_read');
  });

  it('detects Google Docs', () => {
    const result = detectPlatform('https://docs.google.com/document/d/abc/edit', 'My Doc');
    expect(result.type).toBe('document_online');
    expect(result.metadata.documentType).toBe('google_docs');
  });

  it('detects Google Sheets', () => {
    const result = detectPlatform('https://docs.google.com/spreadsheets/d/abc/edit', 'My Sheet');
    expect(result.type).toBe('document_online');
    expect(result.metadata.documentType).toBe('google_sheets');
  });

  it('falls back to website_visit for unknown URLs', () => {
    const result = detectPlatform('https://example.com/page', 'Example');
    expect(result.type).toBe('website_visit');
    expect(result.metadata).toEqual({});
  });

  it('falls back for chrome-internal URLs', () => {
    const result = detectPlatform('https://news.ycombinator.com', 'HN');
    expect(result.type).toBe('website_visit');
  });
});
